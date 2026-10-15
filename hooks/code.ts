// The code view: an Edit or Write replayed as keystrokes under the tree.
// The diff and the replay follow Code Viz's viewer (MIT, Waterside Group:
// plugins/code-viz/server/viewer/diff.js and app.js). Pure, like model.ts.

import type { Clip } from '../types'
import { BASE, CLAUDE, COLOR, FAINT, ICON, MUTED, TINT, mix } from './model'
import type { Seg } from './model'

export const MAX_BYTES = 256 * 1024 // bigger files show in the tree only
const MAX_LINES = 5000
const MAX_DIFF = 1500 // edit distance past which a hunk is replayed as one block
const CONTEXT = 3
const MAX_WINDOW = 80
const MAX_LAG = 2500 // a replay queued further behind than this starts at once
const MAX_QUEUE = 4
export const HOLD = 20_000 // the finished edit stays on screen this long
const MARKS = 8000 // gutter markers fade over this long once the replay ends

const SELECTED = '#264f78'
const TYPED = '#196c2e'
const STRING = '#a5d6ff'
const NUMBER = '#79c0ff'
const KEYWORD = '#ff7b72'

// ---------------------------------------------------------------- lines

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f000}-\u{1fbff}\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u
const ZERO_WIDTH = /[\p{Cc}\p{Cf}\p{M}]/u

/** A line as one cell per character: tabs expanded, wide characters replaced, zero-width ones dropped. */
export function cellSafe(line: string): string {
  let out = ''
  for (const ch of line) {
    if (ch === '\t') {
      out += '  '
    } else if (ZERO_WIDTH.test(ch)) {
      continue
    } else {
      out += WIDE.test(ch) ? '·' : ch
    }
  }
  return out
}

/** Lines as an editor shows them: a trailing newline adds no empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// ---------------------------------------------------------------- diff

const EQ = 0
const DEL = 1
const INS = 2
type DiffOp = { t: typeof EQ | typeof DEL | typeof INS; a: number; b: number }
export type Hunk = { a0: number; a1: number; b0: number; b1: number }

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
const cell = (v: Int32Array, i: number) => v[i] ?? 0

/** Myers' O(ND) diff of `a[a0..a1]` against `b[b0..b1]`; undefined past `maxD`. */
function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, maxD: number): DiffOp[] | undefined {
  const n = a1 - a0
  const m = b1 - b0
  if (n === 0) return range(b0, b1).map(j => ({ t: INS, a: -1, b: j }))
  if (m === 0) return range(a0, a1).map(i => ({ t: DEL, a: i, b: -1 }))

  const lim = Math.min(n + m, maxD)
  const off = lim + 1
  const v = new Int32Array(2 * lim + 3)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= lim; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && cell(v, off + k - 1) < cell(v, off + k + 1)) ? cell(v, off + k + 1) : cell(v, off + k - 1) + 1
      let y = x - k
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return undefined

  const rev: DiffOp[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const t = trace[d] ?? new Int32Array(0)
    const base = d + 1
    const k = x - y
    const pk = k === -d || (k !== d && cell(t, base + k - 1) < cell(t, base + k + 1)) ? k + 1 : k - 1
    const px = cell(t, base + pk)
    const py = px - pk
    while (x > px && y > py) {
      rev.push({ t: EQ, a: a0 + x - 1, b: b0 + y - 1 })
      x--
      y--
    }
    if (d > 0) {
      rev.push(x === px ? { t: INS, a: -1, b: b0 + y - 1 } : { t: DEL, a: a0 + x - 1, b: -1 })
    }
    x = px
    y = py
  }
  return rev.reverse()
}

/** Contiguous change regions, as half-open ranges into `a` and `b`. */
export function hunksOf(a: readonly string[], b: readonly string[]): Hunk[] {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const mid = myers(a, b, s, ea, s, eb, MAX_DIFF)
  if (mid === undefined) return [{ a0: s, a1: ea, b0: s, b1: eb }]

  const out: Hunk[] = []
  let h: Hunk | undefined
  let ai = s
  let bi = s
  for (const o of mid) {
    if (o.t === EQ) {
      if (h) out.push(h)
      h = undefined
      ai = o.a + 1
      bi = o.b + 1
      continue
    }
    h ??= { a0: ai, a1: ai, b0: bi, b1: bi }
    if (o.t === DEL) {
      ai = h.a1 = o.a + 1
    } else {
      bi = h.b1 = o.b + 1
    }
  }
  if (h) out.push(h)
  return out
}

// ---------------------------------------------------------------- clips

/** A window of the file around what changed, or undefined when nothing did or it is too big. */
export function clipOf(path: string, before: string, after: string, at: number): Clip | undefined {
  if (before.length > MAX_BYTES || after.length > MAX_BYTES) return undefined
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length > MAX_LINES || b.length > MAX_LINES) return undefined
  const all = hunksOf(a, b)
  const head = all[0]
  if (head === undefined) return undefined

  // Up to the first hunk the two sides are equal, so both windows start here.
  const start = Math.max(0, head.a0 - CONTEXT)
  const kept = all.filter(h => Math.max(h.a1, h.b1) + CONTEXT - start <= MAX_WINDOW)
  const last = kept[kept.length - 1] ?? head
  const ctx = Math.min(CONTEXT, a.length - last.a1, b.length - last.b1)
  const aEnd = Math.min(last.a1 + ctx, start + MAX_WINDOW)
  const bEnd = Math.min(last.b1 + ctx, start + MAX_WINDOW)
  const left = all.filter(h => h !== last && !kept.includes(h)).reduce((n, h) => n + h.b1 - h.b0, 0)

  const win = { before: a.slice(start, aEnd).map(cellSafe), after: b.slice(start, bEnd).map(cellSafe) }
  return {
    path,
    at,
    dur: totalOf(scriptOf(win.before, win.after).steps),
    first: start + 1,
    ...win,
    more: left + Math.max(0, last.b1 + ctx - bEnd),
    adds: all.reduce((n, h) => n + h.b1 - h.b0, 0),
    dels: all.reduce((n, h) => n + h.a1 - h.a0, 0),
  }
}

/** Queues a clip behind those still playing, unless it would fall too far behind. */
export function enqueue(clips: readonly Clip[], clip: Clip, now: number): Clip[] {
  const busyUntil = Math.max(now, ...clips.map(c => c.at + c.dur))
  const at = busyUntil - now > MAX_LAG ? now : busyUntil
  const live = clips.filter(c => c.at <= at && now - (c.at + c.dur) < HOLD)
  return [...live, { ...clip, at }].slice(-MAX_QUEUE)
}

/** The clip on screen now: the latest one started and not yet put away. */
export function currentClip(clips: readonly Clip[], now: number): Clip | undefined {
  const started = clips.filter(c => c.at <= now)
  const c = started[started.length - 1]
  return c !== undefined && now - (c.at + c.dur) < HOLD ? c : undefined
}

export function isClipDone(clip: Clip, now: number): boolean {
  return now - (clip.at + clip.dur) >= HOLD
}

// ---------------------------------------------------------------- replay

type Kind = 'ctx' | 'del' | 'add' | 'mod'
type Mark = { from: number; to: number; isSelected: boolean }
export type CodeRow = { k: Kind; t: string; c?: number; m?: Mark; r?: 'add' | 'mod'; fold?: number }
type Frame = { rows: CodeRow[]; focus: number }
type Step = { dur: number; at: (p: number) => Frame }
type Script = { steps: Step[]; end: Frame }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const totalOf = (steps: readonly Step[]) => steps.reduce((n, s) => n + s.dur, 0)

/** Whether two lines are one line changed in the middle, so it can be retyped in place. */
function similar(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return p + s >= Math.max(a.length, b.length) * 0.45
}

/** Every frame of turning `before` into `after`, hunk by hunk, as timed steps. */
function scriptOf(before: readonly string[], after: readonly string[]): Script {
  const hunks = hunksOf(before, after)
  const steps: Step[] = []
  const hold = (frame: Frame, dur: number) => steps.push({ dur, at: () => frame })

  // Long edits type faster, so the whole replay stays within a few seconds.
  let chars = 0
  for (const h of hunks) for (let j = h.b0; j < h.b1; j++) chars += (after[j] ?? '').length + 1
  const budget = clamp(500 + chars * 12, 500, 4000)
  const cps = Math.max(40, (chars / budget) * 1000)
  const typing = (n: number, rate: number) => (n / rate) * 1000

  let doc: CodeRow[] = before.map(t => ({ k: 'ctx', t }))
  hunks.forEach((h, i) => {
    const dels = before.slice(h.a0, h.a1)
    const adds = after.slice(h.b0, h.b1)
    const pre = doc.slice(0, h.b0)
    const post = doc.slice(h.b0 + dels.length)
    hold({ rows: doc, focus: h.b0 }, i === 0 ? 140 : 220)

    const isInPlace = dels.length > 0 && dels.length === adds.length && dels.length <= 4 && dels.every((d, j) => similar(d, adds[j] ?? ''))
    if (isInPlace) {
      inPlaceSteps(steps, pre, post, dels, adds, cps, typing)
    } else {
      blockSteps(steps, pre, post, dels, adds, cps, typing)
    }
    const r = dels.length > 0 ? 'mod' : 'add'
    doc = [...pre, ...adds.map((t): CodeRow => ({ k: 'ctx', t, r })), ...post]
  })
  return { steps, end: { rows: doc, focus: hunks[hunks.length - 1]?.b0 ?? 0 } }
}

/** Old lines turn red, the new ones are typed below them, then the red folds away. */
function blockSteps(steps: Step[], pre: CodeRow[], post: CodeRow[], dels: string[], adds: string[], cps: number, typing: (n: number, rate: number) => number) {
  const delRows = dels.map((t): CodeRow => ({ k: 'del', t }))
  if (delRows.length > 0) {
    const frame = { rows: [...pre, ...delRows, ...post], focus: pre.length }
    steps.push({ dur: Math.min(450, 220 + delRows.length * 25), at: () => frame })
  }
  if (adds.length > 0) {
    const full = adds.join('\n')
    steps.push({
      dur: typing(full.length, cps),
      at: p => {
        const typed = full.slice(0, Math.ceil(full.length * p)).split('\n')
        const last = typed.length - 1
        const rows = typed.map((t, j): CodeRow => (j === last ? { k: 'add', t, c: t.length } : { k: 'add', t }))
        return { rows: [...pre, ...delRows, ...rows, ...post], focus: pre.length + delRows.length + last }
      },
    })
  }
  if (delRows.length > 0) {
    const added = adds.map((t): CodeRow => ({ k: 'add', t }))
    steps.push({
      dur: 260,
      at: p => {
        const keep = delRows.slice(0, Math.ceil(delRows.length * (1 - p))).map(r => ({ ...r, fold: p }))
        return { rows: [...pre, ...keep, ...added, ...post], focus: pre.length }
      },
    })
  }
}

/** A small change inside a line: select the old part, backspace it, type the new. */
function inPlaceSteps(steps: Step[], pre: CodeRow[], post: CodeRow[], dels: string[], adds: string[], cps: number, typing: (n: number, rate: number) => number) {
  const done: CodeRow[] = []
  dels.forEach((d, i) => {
    const a = adds[i] ?? ''
    let p = 0
    while (p < d.length && p < a.length && d[p] === a[p]) p++
    let s = 0
    while (s < d.length - p && s < a.length - p && d[d.length - 1 - s] === a[a.length - 1 - s]) s++
    const head = d.slice(0, p)
    const tail = d.slice(d.length - s)
    const oldMid = d.slice(p, d.length - s)
    const newMid = a.slice(p, a.length - s)
    const rest = dels.slice(i + 1).map((t): CodeRow => ({ k: 'ctx', t }))
    const ready = [...done]
    const show = (row: CodeRow): Frame => ({ rows: [...pre, ...ready, row, ...rest, ...post], focus: pre.length + ready.length })

    if (oldMid !== '') {
      const selected = show({ k: 'mod', t: d, m: { from: p, to: p + oldMid.length, isSelected: true }, c: p + oldMid.length })
      steps.push({ dur: 240, at: () => selected })
      // A long selection goes in one keystroke, as an editor deletes it.
      if (oldMid.length <= 24) {
        steps.push({
          dur: typing(oldMid.length, cps * 1.8),
          at: q => {
            const k = oldMid.length - Math.floor(oldMid.length * q)
            const row: CodeRow = { k: 'mod', t: head + oldMid.slice(0, k) + tail, c: p + k }
            return show(k > 0 ? { ...row, m: { from: p, to: p + k, isSelected: true } } : row)
          },
        })
      }
      const cleared = show({ k: 'mod', t: head + tail, c: p })
      steps.push({ dur: 90, at: () => cleared })
    }
    if (newMid !== '') {
      steps.push({
        dur: typing(newMid.length, cps),
        at: q => {
          const n = Math.ceil(newMid.length * q)
          return show({ k: 'mod', t: head + newMid.slice(0, n) + tail, m: { from: p, to: p + n, isSelected: false }, c: p + n })
        },
      })
    }
    done.push({ k: 'ctx', t: a, r: 'mod' })
    const settled = { rows: [...pre, ...done, ...rest, ...post], focus: pre.length + done.length - 1 }
    steps.push({ dur: 70, at: () => settled })
  })
}

// One script is built per clip and reused for every frame of it.
let cached: { key: string; script: Script } | undefined

function scriptFor(clip: Clip): Script {
  const key = `${clip.path}\n${clip.at}`
  if (cached?.key !== key) cached = { key, script: scriptOf(clip.before, clip.after) }
  return cached.script
}

/** The replay at this instant. */
export function frameOf(clip: Clip, now: number): Frame & { isDone: boolean } {
  const { steps, end } = scriptFor(clip)
  let t = Math.max(0, now - clip.at)
  for (const s of steps) {
    if (t < s.dur) return { ...s.at(t / s.dur), isDone: false }
    t -= s.dur
  }
  return { ...end, isDone: true }
}

// ---------------------------------------------------------------- syntax

const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends implements ' +
    'import export from default async await yield try catch finally throw typeof instanceof in of void delete this ' +
    'super null undefined true false def elif lambda pass raise with as is not and or None True False self fn pub ' +
    'struct impl enum trait mut use mod match where type interface package func go defer chan map range public ' +
    'private protected static final abstract readonly declare namespace echo then fi esac local nil end require').split(' '),
)
const HASH_COMMENTS = new Set(['py', 'sh', 'bash', 'zsh', 'fish', 'rb', 'yml', 'yaml', 'toml', 'conf', 'ini', 'pl', 'r', 'mk', 'dockerfile', 'nix'])
const TOKEN = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g

/** One colour per character of a line: comments, strings, numbers and keywords. */
function colours(line: string, hasHashComments: boolean): string[] {
  const out = new Array<string>(line.length).fill(BASE)
  const paintRange = (from: number, to: number, c: string) => out.fill(c, from, to)
  if (/^\s*(\/\*|\*|<!--)/.test(line)) return out.fill(MUTED)
  let code = line
  const slashes = line.search(/\/\/|--\s/)
  const hash = hasHashComments ? line.search(/(^|\s)#/) : -1
  const cut = [slashes, hash].filter(i => i >= 0).sort((x, y) => x - y)[0]
  if (cut !== undefined) {
    paintRange(cut, line.length, MUTED)
    code = line.slice(0, cut)
  }
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(code); m !== null; m = TOKEN.exec(code)) {
    const end = m.index + m[0].length
    if (m[1] !== undefined) {
      paintRange(m.index, end, STRING)
    } else if (m[2] !== undefined) {
      paintRange(m.index, end, NUMBER)
    } else if (KEYWORDS.has(m[0])) {
      paintRange(m.index, end, KEYWORD)
    }
  }
  return out
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? name : name.slice(dot + 1)
}

// ---------------------------------------------------------------- drawing

const smooth = (t: number) => {
  const k = clamp(t, 0, 1)
  return k * k * (3 - 2 * k)
}

/** `── ± src/a.ts:12  +3 -1 ─────`, the code view's rule. */
export function codeRule(clip: Clip, columns: number): Seg[] {
  const isNew = clip.first === 1 && clip.before.length === 0
  const op = isNew ? 'create' : 'edit'
  const where = `:${clip.first}`
  const stats = `  +${clip.adds}` + (clip.dels > 0 ? ` -${clip.dels}` : '')
  const room = Math.max(4, columns - 3 - 2 - where.length - stats.length - 2)
  const path = clip.path.length > room ? '…' + clip.path.slice(clip.path.length - room + 1) : clip.path
  const segs: Seg[] = [
    { t: '── ', c: FAINT },
    { t: ICON[op] + ' ', c: COLOR[op], b: true },
    { t: path, c: BASE, b: true },
    { t: where, c: MUTED },
    { t: `  +${clip.adds}`, c: COLOR.create },
  ]
  if (clip.dels > 0) segs.push({ t: ` -${clip.dels}`, c: COLOR.delete })
  const used = segs.reduce((n, s) => n + s.t.length, 0)
  segs.push({ t: ' ' + '─'.repeat(Math.max(0, columns - used - 2)), c: FAINT })
  return segs
}

/** The replay as styled lines for this instant, at most `rows` of them. */
export function codeLines(clip: Clip, now: number, columns: number, rows: number): Seg[][] {
  const frame = frameOf(clip, now)
  const fade = frame.isDone ? smooth((now - clip.at - clip.dur) / MARKS) : 0
  const numW = String(clip.first + Math.max(clip.before.length, clip.after.length)).length
  const codeW = Math.max(4, columns - numW - 3)
  const hasHash = HASH_COMMENTS.has(extOf(clip.path))

  // Line numbers count the file as it is now, so removed lines get none.
  let no = clip.first
  const numbers = frame.rows.map(r => (r.k === 'del' ? undefined : no++))

  const room = Math.max(1, rows - (clip.more > 0 ? 1 : 0))
  const start = clamp(frame.focus - Math.floor(room / 3), 0, Math.max(0, frame.rows.length - room))
  const caret = frame.rows[frame.focus]?.c
  const shift = caret !== undefined && caret > codeW - 2 ? caret - (codeW - 2) : 0

  const out = frame.rows.slice(start, start + room).map((r, i) => rowSegs(r, numbers[start + i], numW, codeW, shift, fade, hasHash))
  if (clip.more > 0) out.push([{ t: ' '.repeat(numW + 2) + `… ${clip.more} more changed lines`, c: FAINT }])
  return out
}

function rowSegs(r: CodeRow, no: number | undefined, numW: number, codeW: number, shift: number, fade: number, hasHash: boolean): Seg[] {
  const fold = r.fold ?? 0
  const segs: Seg[] = [{ t: (no === undefined ? '' : String(no)).padStart(numW), c: r.k === 'ctx' && r.r === undefined ? FAINT : MUTED }]

  if (r.k === 'del') {
    segs.push({ t: '-', c: mix(COLOR.delete, FAINT, fold), b: true })
  } else if (r.k === 'add') {
    segs.push({ t: '+', c: COLOR.create, b: true })
  } else if (r.k === 'mod') {
    segs.push({ t: '▎', c: COLOR.edit, b: true })
  } else if (r.r !== undefined && fade < 1) {
    segs.push({ t: '▎', c: mix(r.r === 'add' ? COLOR.create : COLOR.edit, FAINT, fade) })
  } else {
    segs.push({ t: ' ' })
  }
  segs.push({ t: ' ' })

  const bg = r.k === 'del' ? mix(TINT.delete, '#0d1117', fold) : r.k === 'add' ? TINT.create : undefined
  const tone = colours(r.t, hasHash)
  const visible = r.t.slice(shift, shift + codeW)
  const isCut = r.t.length > shift + codeW
  for (let i = 0; i < visible.length; i++) {
    const at = shift + i
    if (isCut && i === codeW - 1) {
      segs.push({ t: '›', c: MUTED, bg })
      break
    }
    const inMark = r.m !== undefined && at >= r.m.from && at < r.m.to
    let c = tone[at] ?? BASE
    let cellBg = bg
    if (r.k === 'del') c = mix(mix(COLOR.delete, BASE, 0.25), FAINT, fold)
    if (inMark && r.m?.isSelected) {
      cellBg = SELECTED
    } else if (inMark) {
      cellBg = TYPED
      c = '#d2f8dc'
    }
    if (r.c === at) {
      cellBg = CLAUDE
      c = '#0d1117'
    }
    segs.push({ t: visible[i] ?? ' ', c, bg: cellBg, s: r.k === 'del' && fold > 0 })
  }
  // The caret after the last character, then the row's tint to the edge.
  let used = visible.length
  if (r.c !== undefined && r.c - shift >= visible.length && used < codeW) {
    segs.push({ t: '▏', c: CLAUDE, bg, b: true })
    used++
  }
  if (bg !== undefined && used < codeW) segs.push({ t: ' '.repeat(codeW - used), bg })
  return segs
}
