// The code view: an Edit or Write replayed as keystrokes under the tree.
// The diff and the replay follow Code Viz's viewer (MIT, Waterside Group:
// plugins/code-viz/server/viewer/diff.js and app.js). Pure, like model.ts.

import type { Clip } from '../types'
import { BASE, COLOR, FAINT, ICON, MUTED, mix } from './model'
import Prism from './vendor/prism'
import type { PrismStream } from './vendor/prism'
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

// Tokyo Night (night): the diff, selection and caret colours of the code view.
const TN = {
  text: '#c0caf5',
  gutter: '#3b4261',
  number: '#737aa2',
  added: '#20303b',
  removed: '#37222c',
  typed: '#2c5a66',
  selected: '#33467c',
  caret: '#7aa2f7',
  plus: '#9ece6a',
  minus: '#f7768e',
  changed: '#e0af68',
}
const WRAP = '↳' // marks a row that continues the line above
const GLOW = 5 // typed characters this close behind the caret glow
const MIN_TYPING = 650 // ms the typing of even a tiny edit takes, at most MIN_CPS
const MAX_TYPING = 3500
const MIN_CPS = 26
const MS_PER_CHAR = 10

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
    file: b.map(cellSafe),
    changed: all.flatMap(h => range(h.b0 + 1, h.b1 + 1)),
  }
}

export const clipKey = (clip: Clip) => `${clip.path}\n${clip.at}`

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

/** Lines an Edit or Write added and removed, from its result's `structuredPatch`. */
export function patchStats(output: unknown): { adds: number; dels: number } | undefined {
  const patch = (output as { structuredPatch?: unknown } | undefined)?.structuredPatch
  if (!Array.isArray(patch)) return undefined
  let adds = 0
  let dels = 0
  for (const hunk of patch as { lines?: unknown }[]) {
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) adds++
      else if (line.startsWith('-')) dels++
    }
  }
  return { adds, dels }
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

/** How many characters retyping `b` over `a` in place types: the part between their common ends. */
function changedPart(a: string, b: string): number {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return b.length - p - s
}

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

  // Speed comes from what is actually typed: long edits type faster, so the
  // replay stays within a few seconds, and a few characters still take a beat.
  const isInPlace = (h: Hunk) => {
    const dels = before.slice(h.a0, h.a1)
    const adds = after.slice(h.b0, h.b1)
    return dels.length > 0 && dels.length === adds.length && dels.length <= 4 && dels.every((d, j) => similar(d, adds[j] ?? ''))
  }
  let chars = 0
  for (const h of hunks) {
    for (let j = h.b0; j < h.b1; j++) {
      const a = after[j] ?? ''
      chars += isInPlace(h) ? changedPart(before[h.a0 + j - h.b0] ?? '', a) + 1 : a.length + 1
    }
  }
  const budget = clamp(MIN_TYPING + chars * MS_PER_CHAR, MIN_TYPING, MAX_TYPING)
  const cps = Math.max(MIN_CPS, (chars / budget) * 1000)
  const typing = (n: number, rate: number) => (n / rate) * 1000

  let doc: CodeRow[] = before.map(t => ({ k: 'ctx', t }))
  hunks.forEach((h, i) => {
    const dels = before.slice(h.a0, h.a1)
    const adds = after.slice(h.b0, h.b1)
    const pre = doc.slice(0, h.b0)
    const post = doc.slice(h.b0 + dels.length)
    hold({ rows: doc, focus: h.b0 }, i === 0 ? 140 : 220)

    if (isInPlace(h)) {
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

// Prism's grammar for each file name or extension.
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', php: 'php', phtml: 'php', py: 'python', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', sh: 'bash',
  bash: 'bash', zsh: 'bash', fish: 'bash', json: 'json', jsonc: 'json', lock: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', sql: 'sql', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  lua: 'lua', kt: 'kotlin', kts: 'kotlin', swift: 'swift', css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', diff: 'diff',
  patch: 'diff', pl: 'perl', pm: 'perl', r: 'r', scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', graphql: 'graphql', gql: 'graphql', twig: 'twig', mk: 'makefile', ps1: 'powershell', m: 'objectivec',
  tf: 'hcl', hcl: 'hcl', nix: 'nix', groovy: 'groovy', gradle: 'groovy', properties: 'properties', env: 'properties',
  zig: 'zig', vim: 'vim', erl: 'erlang', clj: 'clojure', cljs: 'clojure', ml: 'ocaml', fs: 'fsharp', jl: 'julia',
  proto: 'protobuf', liquid: 'liquid', hbs: 'handlebars', handlebars: 'handlebars', pug: 'pug',
  dockerfile: 'docker', makefile: 'makefile', '.htaccess': 'apacheconf', '.env': 'properties', '.bashrc': 'bash',
  '.zshrc': 'bash', '.profile': 'bash', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby', 'nginx.conf': 'nginx',
}

// Tokyo Night's colour for each kind of Prism token.
const PALETTE: Record<string, string> = {
  comment: '#565f89', prolog: '#565f89', doctype: '#565f89', cdata: '#565f89',
  keyword: '#bb9af7', atrule: '#bb9af7', selector: '#bb9af7', 'attr-name': '#bb9af7', rule: '#bb9af7',
  string: '#9ece6a', char: '#9ece6a', 'attr-value': '#9ece6a', 'template-string': '#9ece6a', inserted: '#9ece6a',
  number: '#ff9e64', boolean: '#ff9e64', constant: '#ff9e64', symbol: '#ff9e64', entity: '#ff9e64', important: '#ff9e64',
  function: '#7aa2f7', 'function-name': '#7aa2f7', title: '#7aa2f7',
  'class-name': '#2ac3de', builtin: '#2ac3de', namespace: '#2ac3de',
  operator: '#89ddff', regex: '#b4f9f8', url: '#73daca', property: '#73daca', key: '#73daca',
  punctuation: '#a9b1d6', variable: '#c0caf5', parameter: '#e0af68', tag: '#f7768e', deleted: '#f7768e',
  interpolation: '#7dcfff', 'template-punctuation': '#9ece6a', bold: '#e0af68', italic: '#e0af68', code: '#9ece6a',
}

/** Prism's grammar for a file, by its name or extension; undefined for plain text. */
export function grammarOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (/(^|\/)nginx\//.test(path) && name.endsWith('.conf')) return 'nginx'
  const dot = name.lastIndexOf('.')
  const id = LANGUAGES[name] ?? (dot < 0 ? undefined : LANGUAGES[name.slice(dot + 1)])
  return id !== undefined && Prism.languages[id] !== undefined ? id : undefined
}

function paintStream(stream: PrismStream, colour: string, out: string[]) {
  if (typeof stream === 'string') {
    for (let i = 0; i < stream.length; i++) out.push(colour)
    return
  }
  if (Array.isArray(stream)) {
    for (const part of stream) paintStream(part, colour, out)
    return
  }
  const aliases = stream.alias === undefined ? [] : ([] as string[]).concat(stream.alias)
  const own = PALETTE[stream.type] ?? aliases.map(a => PALETTE[a]).find(c => c !== undefined)
  paintStream(stream.content, own ?? colour, out)
}

// The text of the last frame and its colours: typing changes one character at a time.
let painted: { key: string; colours: string[] } | undefined

/** One colour per character of `text`, highlighted as one piece so comments and strings span lines. */
export function coloursOf(text: string, grammar: string | undefined): string[] {
  const key = `${grammar ?? ''}\n${text}`
  if (painted?.key === key) return painted.colours
  const out: string[] = []
  const rules = grammar === undefined ? undefined : Prism.languages[grammar]
  if (rules === undefined) {
    out.length = text.length
    out.fill(TN.text)
  } else {
    try {
      paintStream(Prism.tokenize(text, rules), TN.text, out)
    } catch {
      out.length = 0
    }
    while (out.length < text.length) out.push(TN.text)
  }
  painted = { key, colours: out }
  return out
}

// ---------------------------------------------------------------- drawing

const smooth = (t: number) => {
  const k = clamp(t, 0, 1)
  return k * k * (3 - 2 * k)
}

/** `── ± src/a.ts:12  +3 -1 ─────`, the code view's rule; while scrolled, the lines in view. */
export function codeRule(clip: Clip, columns: number, view?: { from: number; to: number }): Seg[] {
  const isNew = clip.first === 1 && clip.before.length === 0
  const op = isNew ? 'create' : 'edit'
  const where = view === undefined ? `:${clip.first}` : ''
  const stats = view === undefined ? `  +${clip.adds}` + (clip.dels > 0 ? ` -${clip.dels}` : '') : `  lines ${view.from}-${view.to} / ${clip.file.length}`
  const room = Math.max(4, columns - 3 - 2 - where.length - stats.length - 2)
  const path = clip.path.length > room ? '…' + clip.path.slice(clip.path.length - room + 1) : clip.path
  const segs: Seg[] = [
    { t: '── ', c: FAINT },
    { t: ICON[op] + ' ', c: COLOR[op], b: true },
    { t: path, c: BASE, b: true },
    { t: where, c: MUTED },
  ]
  if (view !== undefined) {
    segs.push({ t: stats, c: MUTED })
  } else {
    segs.push({ t: `  +${clip.adds}`, c: COLOR.create })
    if (clip.dels > 0) segs.push({ t: ` -${clip.dels}`, c: COLOR.delete })
  }
  const used = segs.reduce((n, s) => n + s.t.length, 0)
  segs.push({ t: ' ' + '─'.repeat(Math.max(0, columns - used - 2)), c: FAINT })
  return segs
}

/** One screen row: a slice of a code line, wrapped at the pane's width. */
type Visual = { row: CodeRow; no: number | undefined; from: number; to: number; isFirst: boolean; offset: number }

/**
 * The replay as styled lines for this instant, at most `rows` of them, long
 * lines wrapped. `scroll` is the first row shown last frame: the window eases
 * toward the caret from there, and the new value comes back with the lines.
 */
export function codeLines(clip: Clip, now: number, columns: number, rows: number, scroll = 0): { lines: Seg[][]; scroll: number } {
  const frame = frameOf(clip, now)
  const fade = frame.isDone ? smooth((now - clip.at - clip.dur) / MARKS) : 0
  const numW = String(clip.first + Math.max(clip.before.length, clip.after.length)).length
  const codeW = Math.max(4, columns - numW - 3)

  // The whole frame is highlighted as one text, so strings and comments carry across lines.
  let offset = 0
  const offsets = frame.rows.map(r => {
    const at = offset
    offset += r.t.length + 1
    return at
  })
  const colours = coloursOf(frame.rows.map(r => r.t).join('\n'), grammarOf(clip.path))

  // Line numbers count the file as it is now, so removed lines get none.
  let no = clip.first
  const visual: Visual[] = []
  let focusAt = 0
  frame.rows.forEach((row, i) => {
    const number = row.k === 'del' ? undefined : no++
    // A caret just past a full last row starts a row of its own.
    const len = row.t.length + (row.c !== undefined && row.c === row.t.length && row.t.length % codeW === 0 && row.t.length > 0 ? 1 : 0)
    const pieces = Math.max(1, Math.ceil(len / codeW))
    if (i === frame.focus) focusAt = visual.length + (row.c === undefined ? 0 : Math.min(pieces - 1, Math.floor(row.c / codeW)))
    for (let k = 0; k < pieces; k++) {
      visual.push({ row, no: number, from: k * codeW, to: Math.min(row.t.length, (k + 1) * codeW), isFirst: k === 0, offset: offsets[i] ?? 0 })
    }
  })

  const room = Math.max(1, rows - (clip.more > 0 ? 1 : 0))
  const max = Math.max(0, visual.length - room)
  let target = clamp(scroll, 0, max)
  if (focusAt < target + 1 || focusAt > target + room - 2) target = clamp(focusAt - Math.floor(room / 3), 0, max)
  const delta = target - scroll
  const next = delta === 0 ? clamp(scroll, 0, max) : clamp(scroll + Math.sign(delta) * Math.max(1, Math.ceil(Math.abs(delta) / 4)), 0, max)

  const lines = visual.slice(next, next + room).map(v => rowSegs(v, numW, codeW, fade, colours))
  if (clip.more > 0) lines.push([{ t: ' '.repeat(numW + 2) + `… ${clip.more} more changed lines`, c: FAINT }])
  return { lines, scroll: next }
}

function rowSegs(v: Visual, numW: number, codeW: number, fade: number, colours: readonly string[]): Seg[] {
  const { row: r } = v
  const fold = r.fold ?? 0
  const label = v.isFirst && v.no !== undefined ? String(v.no) : v.isFirst ? '' : WRAP
  const segs: Seg[] = [{ t: label.padStart(numW), c: r.k === 'ctx' && r.r === undefined ? TN.gutter : TN.number }]

  if (r.k === 'del') {
    segs.push({ t: v.isFirst ? '-' : ' ', c: mix(TN.minus, FAINT, fold), b: true })
  } else if (r.k === 'add') {
    segs.push({ t: v.isFirst ? '+' : ' ', c: TN.plus, b: true })
  } else if (r.k === 'mod') {
    segs.push({ t: '▎', c: TN.changed, b: true })
  } else if (r.r !== undefined && fade < 1) {
    segs.push({ t: '▎', c: mix(r.r === 'add' ? TN.plus : TN.changed, FAINT, fade) })
  } else {
    segs.push({ t: ' ' })
  }
  segs.push({ t: ' ' })

  const bg = r.k === 'del' ? mix(TN.removed, '#000000', fold) : r.k === 'add' ? TN.added : undefined
  for (let at = v.from; at < v.to; at++) {
    const inMark = r.m !== undefined && at >= r.m.from && at < r.m.to
    let c = colours[v.offset + at] ?? TN.text
    let cellBg = bg
    if (r.k === 'del') c = mix(mix(TN.minus, TN.text, 0.35), FAINT, fold)
    if (inMark && r.m?.isSelected) {
      cellBg = TN.selected
    } else if (inMark) {
      cellBg = TN.typed
    }
    // What was just typed glows, cooling as the caret moves on.
    if (r.c !== undefined && at < r.c && r.c - at <= GLOW && r.k !== 'del') c = mix(c, '#ffffff', 0.55 * (1 - (r.c - at - 1) / GLOW))
    if (r.c === at) {
      cellBg = TN.caret
      c = '#000000'
    }
    segs.push({ t: r.t[at] ?? ' ', c, bg: cellBg, s: r.k === 'del' && fold > 0 })
  }
  // The caret after the last character, then the row's tint to the edge.
  let used = v.to - v.from
  if (r.c !== undefined && r.c >= r.t.length && r.c === v.to && used < codeW) {
    segs.push({ t: '▏', c: TN.caret, bg, b: true })
    used++
  }
  if (bg !== undefined && used < codeW) segs.push({ t: ' '.repeat(codeW - used), bg })
  return segs
}

/** Where the code view sits in the pane's body, for telling a wheel tick over it from one over the tree. */
export type CodeArea = { column: number; row: number; columns: number; rows: number }

export function isOverCode(pointer: { column: number; row: number }, area: CodeArea): boolean {
  return pointer.column >= area.column && pointer.column < area.column + area.columns && pointer.row >= area.row && pointer.row < area.row + area.rows
}

/** The person's place in a clip's file while they scroll it: its top line, and when they last moved. */
export type Browse = { key: string; top: number; at: number }

const WHEEL_LINES = 2 // lines one wheel or touchpad tick moves the file

/**
 * Where a scroll leaves the person in the code view's file, or undefined
 * when it isn't theirs to take: no code view, or a pointer over the tree.
 * Keys (no pointer) move a line each, a wheel or touchpad tick WHEEL_LINES.
 */
export function browseAfter(
  current: Browse | undefined,
  clip: Clip | undefined,
  area: CodeArea | undefined,
  scroll: { by: number; pointer?: { column: number; row: number } },
  now: number,
): Browse | undefined {
  if (clip === undefined || area === undefined) return undefined
  if (scroll.pointer !== undefined && !isOverCode(scroll.pointer, area)) return undefined
  const top = current?.key === clipKey(clip) ? current.top : clip.first - 1
  const lines = scroll.pointer === undefined ? scroll.by : scroll.by * WHEEL_LINES
  return { key: clipKey(clip), top: Math.max(0, top + lines), at: now }
}

const COLOUR_MARGIN = 40 // lines highlighted around the view, so a string or comment opened above still reads right

/**
 * The whole file after the edit, from line `top` (0-based) down, wrapped,
 * the edit's lines marked: what the person scrolls through. `top` comes back
 * clamped, with the line range in view for the rule.
 */
export function fileLines(clip: Clip, columns: number, rows: number, top: number): { lines: Seg[][]; top: number; from: number; to: number } {
  const lines = clip.file
  const numW = String(Math.max(1, lines.length)).length
  const codeW = Math.max(4, columns - numW - 3)
  const first = clamp(Math.round(top), 0, Math.max(0, lines.length - rows))
  const from = Math.max(0, first - COLOUR_MARGIN)
  const slice = lines.slice(from, Math.min(lines.length, first + rows + COLOUR_MARGIN))
  const colours = coloursOf(slice.join('\n'), grammarOf(clip.path))
  const changed = new Set(clip.changed)

  const out: Seg[][] = []
  let offset = slice.slice(0, first - from).reduce((n, l) => n + l.length + 1, 0)
  let last = first
  for (let i = first; i < lines.length && out.length < rows; i++) {
    const t = lines[i] ?? ''
    const row: CodeRow = changed.has(i + 1) ? { k: 'ctx', t, r: 'mod' } : { k: 'ctx', t }
    const pieces = Math.max(1, Math.ceil(t.length / codeW))
    for (let k = 0; k < pieces && out.length < rows; k++) {
      out.push(rowSegs({ row, no: i + 1, from: k * codeW, to: Math.min(t.length, (k + 1) * codeW), isFirst: k === 0, offset }, numW, codeW, 0, colours))
    }
    offset += t.length + 1
    last = i
  }
  return { lines: out, top: first, from: first + 1, to: last + 1 }
}
