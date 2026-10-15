// Pure logic of the work map: classifying tool calls, diffing scans, and
// turning the tree plus Claude's activity into styled rows for a given instant.
// Nothing here touches `$`, so tests drive it with plain values.

import type { Activity, Ghost, Op, TreeEntry, TurnInfo } from '../types'

export const OPS: readonly Op[] = ['view', 'edit', 'create', 'delete']

export const COLOR: Record<Op, string> = {
  view: '#58a6ff',
  edit: '#f0883e',
  create: '#3fb950',
  delete: '#f85149',
}
/** Each op's colour at full brightness, for highlights riding over it. */
const HOT: Record<Op, string> = {
  view: '#cfe6ff',
  edit: '#ffe2c4',
  create: '#d2f8dc',
  delete: '#ffd7d5',
}
export const TINT: Record<Op, string> = {
  view: '#0c2d4f',
  edit: '#3d2410',
  create: '#0f3a1e',
  delete: '#4a1316',
}
// One terminal cell each, so the tree's columns never drift.
export const ICON: Record<Op, string> = { view: '◉', edit: '±', create: '+', delete: '✗' }
export const LABEL: Record<Op, string> = {
  view: 'read',
  edit: 'edit',
  create: 'new',
  delete: 'delete',
}
export const VERB: Record<Op, string> = { view: 'reading', edit: 'editing', create: 'creating', delete: 'deleting' }

export const BASE = '#c9d1d9'
export const MUTED = '#6e7681'
const FOLDER = '#8b98a5'
export const FAINT = '#30363d'
export const CLAUDE = '#d97757'

// Timeline, in milliseconds.
export const T = {
  entrance: 700, // create: name grows into the tree
  done: 1800, // completed flash
  recent: 20_000, // op icon kept, colour decaying
  trail: 60_000, // faint check mark, then back to normal
  keepOpen: 120_000, // folders with activity this recent stay expanded
  ghostHighlight: 450,
  ghostShake: 1050,
  ghostGone: 2300,
  expand: 450,
  collapse: 500,
  summary: 20_000,
}

export const IGNORED = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', '.mypy_cache', '.pytest_cache', 'dist', 'build', 'out', 'target', 'coverage',
  '.idea', '.DS_Store',
])

// ---------------------------------------------------------------- paths

export function relPath(cwd: string, path: string): string | undefined {
  const root = cwd.replace(/\/+$/, '')
  let p = path.trim()
  if (p === '') return undefined
  if (p.startsWith('./')) p = p.slice(2)
  if (p.startsWith('/')) {
    if (p === root) return undefined
    if (!p.startsWith(root + '/')) return undefined
    p = p.slice(root.length + 1)
  }
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  if (parts.length === 0) return undefined
  if (parts.some(part => IGNORED.has(part))) return undefined
  return parts.join('/')
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function ancestors(path: string): string[] {
  const out: string[] = []
  for (let p = parentOf(path); p !== ''; p = parentOf(p)) out.push(p)
  return out
}

/** Adds `path` (and any missing parent folders) to a tree. */
export function withPath(tree: readonly TreeEntry[], path: string, d: boolean): TreeEntry[] {
  const have = new Set(tree.map(t => t.p))
  const add: TreeEntry[] = []
  for (const dir of ancestors(path)) if (!have.has(dir)) add.push({ p: dir, d: true, m: 0 })
  if (!have.has(path)) add.push({ p: path, d, m: 0 })
  return add.length === 0 ? [...tree] : [...tree, ...add]
}

export function withoutPath(tree: readonly TreeEntry[], path: string): TreeEntry[] {
  return tree.filter(t => t.p !== path && !t.p.startsWith(path + '/'))
}

// ---------------------------------------------------------------- bash

export type Target = { op: Op; path: string }

const VIEWERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'grep', 'rg', 'ag', 'diff', 'file', 'stat',
  'nl', 'jq', 'awk', 'sed', 'cut', 'sort', 'uniq', 'xxd', 'hexdump', 'od', 'strings', 'md5sum',
  'sha256sum', 'ls', 'tree', 'find',
])
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'trash', 'shred'])

function tokenize(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

/**
 * Best-effort reading of a shell command: which paths it reads, writes,
 * creates or deletes. The scan diff after the command catches what this
 * misses, so it only has to be right about what to animate while it runs.
 */
export function classifyBash(command: string): Target[] {
  const targets: Target[] = []
  const segments = command.split(/&&|\|\||;|\||\n/)
  for (const segment of segments) {
    let words = tokenize(segment.trim())
    // Redirections: `> file` writes, `< file` reads.
    const rest: string[] = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? ''
      const redirect = /^(\d?>>?|&>)(.*)$/.exec(w)
      if (redirect) {
        const target = redirect[2] !== '' ? redirect[2] : words[++i]
        if (target && !target.startsWith('&') && target !== '/dev/null') targets.push({ op: 'edit', path: target })
        continue
      }
      if (w === '<' && words[i + 1]) {
        targets.push({ op: 'view', path: words[++i] ?? '' })
        continue
      }
      rest.push(w)
    }
    words = rest
    while (words[0] !== undefined && (/^\w+=/.test(words[0]) || ['sudo', 'command', 'exec', 'time'].includes(words[0]))) words = words.slice(1)
    let cmd = words[0]
    if (cmd === undefined) continue
    cmd = baseName(cmd)
    let args = words.slice(1)
    if (cmd === 'git' && (args[0] === 'rm' || args[0] === 'mv')) {
      cmd = args[0]
      args = args.slice(1)
    }
    const operands = args.filter(a => !a.startsWith('-') && !/[*?$`(){}]/.test(a))
    if (DELETERS.has(cmd)) {
      for (const p of operands) targets.push({ op: 'delete', path: p })
    } else if (cmd === 'touch' || cmd === 'mkdir') {
      for (const p of operands) targets.push({ op: 'create', path: p })
    } else if (cmd === 'mv' && operands.length >= 2) {
      const dest = operands[operands.length - 1] ?? ''
      for (const p of operands.slice(0, -1)) targets.push({ op: 'delete', path: p })
      targets.push({ op: 'create', path: dest })
    } else if (cmd === 'cp' && operands.length >= 2) {
      const dest = operands[operands.length - 1] ?? ''
      for (const p of operands.slice(0, -1)) targets.push({ op: 'view', path: p })
      targets.push({ op: 'create', path: dest })
    } else if (cmd === 'tee') {
      for (const p of operands) targets.push({ op: 'edit', path: p })
    } else if ((cmd === 'sed' || cmd === 'perl') && args.some(a => /^-[a-zA-Z]*i/.test(a))) {
      for (const p of operands.slice(1)) targets.push({ op: 'edit', path: p })
    } else if (VIEWERS.has(cmd)) {
      // grep/sed/awk/jq take a pattern or program first.
      const skip = ['grep', 'rg', 'ag', 'sed', 'awk', 'jq'].includes(cmd) ? 1 : 0
      for (const p of operands.slice(skip)) targets.push({ op: 'view', path: p })
    }
  }
  return targets
}

// ---------------------------------------------------------------- diffs

export type Diff = { created: TreeEntry[]; deleted: TreeEntry[]; edited: string[] }

/** The folders each scan listed in full: only their children can be known to be new or gone. */
export type Listed = { before: ReadonlySet<string>; after: ReadonlySet<string> }

export function diffTrees(before: readonly TreeEntry[], after: readonly TreeEntry[], listed?: Listed): Diff {
  const old = new Map(before.map(t => [t.p, t]))
  const now = new Map(after.map(t => [t.p, t]))
  // A path in a folder the scan cut off may only have slid in or out of its window.
  const wasListed = (p: string) => listed === undefined || listed.before.has(parentOf(p))
  const isListed = (p: string) => listed === undefined || listed.after.has(parentOf(p))
  const created: TreeEntry[] = []
  const edited: string[] = []
  for (const t of after) {
    const was = old.get(t.p)
    if (was === undefined && wasListed(t.p)) created.push(t)
    else if (was !== undefined && !t.d && was.m !== 0 && t.m !== was.m) edited.push(t.p)
  }
  // A deleted folder shows as one ghost, not one per file inside it.
  const deleted = before.filter(t => !now.has(t.p) && (parentOf(t.p) === '' || now.has(parentOf(t.p))) && isListed(t.p))
  return { created, deleted, edited }
}

// ---------------------------------------------------------------- colour

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const [r1, g1, b1] = hex(a)
  const [r2, g2, b2] = hex(b)
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0')
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)

// ---------------------------------------------------------------- activity

export type Level = 'active' | 'done' | 'recent' | 'trail' | 'none'

export function levelOf(a: Activity | undefined, now: number): Level {
  if (a === undefined) return 'none'
  if (a.running > 0 || a.endedAt === undefined) return 'active'
  const age = now - a.endedAt
  if (age < T.done) return 'done'
  if (age < T.recent) return 'recent'
  if (age < T.trail) return 'trail'
  return 'none'
}

/** 1 for the running operation, decaying to 0 as Claude moves on. */
export function intensityOf(a: Activity | undefined, now: number): number {
  const level = levelOf(a, now)
  if (level === 'active') return 1
  if (level === 'none' || a?.endedAt === undefined) return 0
  const age = now - a.endedAt
  if (level === 'done') return 0.85
  return 0.75 * (1 - ease(age / T.trail))
}

/** The file Claude is working on right now: the latest running operation. */
export function focusOf(activity: Readonly<Record<string, Activity>>): string | undefined {
  let best: string | undefined
  let at = -Infinity
  for (const [path, a] of Object.entries(activity)) {
    if (a.running > 0 && a.startedAt >= at) {
      best = path
      at = a.startedAt
    }
  }
  return best
}

export function isAnimating(
  activity: Readonly<Record<string, Activity>>,
  ghosts: Readonly<Record<string, Ghost>>,
  turn: TurnInfo,
  now: number,
): boolean {
  if (Object.keys(ghosts).length > 0) return true
  if (turn.phase === 'complete' && now - turn.at < T.summary + 1000) return true
  return Object.values(activity).some(a => levelOf(a, now) !== 'none')
}

/** Activity records old enough to have no effect on the drawing. */
export function staleKeys(activity: Readonly<Record<string, Activity>>, now: number): string[] {
  return Object.entries(activity)
    .filter(([, a]) => levelOf(a, now) === 'none' && now - (a.endedAt ?? now) > T.keepOpen)
    .map(([p]) => p)
}

// ---------------------------------------------------------------- rows

export type Seg = {
  t: string
  c?: string
  bg?: string
  b?: boolean
  dim?: boolean
  s?: boolean
}
export type Row = { key: string; path: string; segs: Seg[] }

/** Per-folder open/closed memory, so expansion and collapse can animate. */
export type FolderMemory = Map<string, { open: boolean; at: number }>

type Node = { p: string; d: boolean; ghost?: Ghost }

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
/** Smoothstep: eases in and out, so motion has no visible start or stop. */
const smooth = (t: number) => {
  const k = clamp01(t)
  return k * k * (3 - 2 * k)
}
const pulse = (now: number, period: number, phase = 0) => (Math.sin(((now - phase) / period) * Math.PI * 2) + 1) / 2

function sortNodes(a: Node, b: Node): number {
  if (a.d !== b.d) return a.d ? -1 : 1
  return baseName(a.p).localeCompare(baseName(b.p), undefined, { sensitivity: 'base' })
}

function truncate(text: string, room: number): string {
  if (room <= 0) return ''
  const chars = [...text]
  if (chars.length <= room) return text
  return chars.slice(0, Math.max(0, room - 1)).join('') + '…'
}

export const cells = (segs: readonly Seg[]) => segs.reduce((w, s) => w + [...s.t].length, 0)

/** A string as one segment per cell, each styled by its index. */
function paint(text: string, style: (i: number, n: number) => Omit<Seg, 't'>): Seg[] {
  const chars = [...text]
  return chars.map((t, i) => ({ t, ...style(i, chars.length) }))
}

/** A moving highlight band at fractional position `at`, `radius` cells wide. */
function band(i: number, at: number, radius: number): number {
  return smooth(1 - Math.abs(i - at) / radius)
}

export type Scene = {
  tree: readonly TreeEntry[]
  activity: Readonly<Record<string, Activity>>
  ghosts: Readonly<Record<string, Ghost>>
  now: number
  columns: number
  folders: FolderMemory
}

type Guide = { more: boolean; lit: number; op?: Op }

/** The tree as styled rows for this instant. */
export function buildRows(scene: Scene): Row[] {
  const { tree, activity, ghosts, now, columns, folders } = scene
  const nodes = new Map<string, Node>()
  for (const t of tree) nodes.set(t.p, { p: t.p, d: t.d })
  for (const [p, g] of Object.entries(ghosts)) {
    if (now - g.at >= T.ghostGone) continue
    nodes.set(p, { p, d: g.d, ghost: g })
    for (const dir of ancestors(p)) if (!nodes.has(dir)) nodes.set(dir, { p: dir, d: true })
  }
  const children = new Map<string, Node[]>()
  for (const n of nodes.values()) {
    const parent = parentOf(n.p)
    if (parent !== '' && !nodes.has(parent)) continue
    const list = children.get(parent) ?? []
    list.push(n)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort(sortNodes)

  const focus = focusOf(activity)
  const focusOp = focus === undefined ? undefined : activity[focus]?.op
  const focusChain = new Set(focus === undefined ? [] : ancestors(focus))
  const onChain = (p: string) => p === focus || focusChain.has(p)

  // Strongest activity at or under each folder, weakened per level climbed.
  const heat = new Map<string, { v: number; op: Op }>()
  const busy = new Set<string>()
  for (const [p, a] of Object.entries(activity)) {
    const v = intensityOf(a, now)
    if (a.endedAt === undefined || a.running > 0 || now - a.endedAt < T.keepOpen) {
      for (const dir of ancestors(p)) busy.add(dir)
      if (nodes.get(p)?.d) busy.add(p)
    }
    if (v <= 0) continue
    ancestors(p).forEach((dir, i) => {
      const w = v * Math.pow(0.68, i + 1)
      const had = heat.get(dir)
      if (had === undefined || had.v < w) heat.set(dir, { v: w, op: a.op })
    })
  }
  for (const p of Object.keys(ghosts)) for (const dir of ancestors(p)) busy.add(dir)

  const fileCount = tree.filter(t => !t.d).length
  const wantsOpen = (dir: string, depth: number) =>
    fileCount <= 40 || busy.has(dir) || (depth === 0 && tree.length <= 150)

  // The signal running down the tree toward the focused file.
  const signal = (depth: number) => 0.45 + 0.55 * pulse(now, 1300, depth * 140)

  function guideSegs(guides: readonly Guide[], isLast: boolean, own: Guide | undefined): Seg[] {
    if (guides.length === 0 && own === undefined) return []
    const segs: Seg[] = guides.slice(0, -1).map((g, level) => ({
      t: g.more ? '│ ' : '  ',
      c: g.lit > 0 && g.op ? mix(FAINT, COLOR[g.op], g.lit * signal(level)) : FAINT,
    }))
    const level = guides.length - 1
    const lit = own?.lit ?? 0
    const op = own?.op
    segs.push({ t: isLast ? '└╴' : '├╴', c: lit > 0 && op ? mix(FAINT, COLOR[op], lit * signal(level)) : FAINT })
    return segs
  }

  function fadeIn(segs: Seg[], fade: number): Seg[] {
    if (fade <= 0.02) return segs
    return segs.map(s => ({ ...s, c: mix(s.c ?? BASE, FAINT, fade), bg: undefined, b: false }))
  }

  const rows: Row[] = []
  const walk = (parent: string, depth: number, fade: number, guides: Guide[]) => {
    const list = children.get(parent) ?? []
    const chainAt = list.findIndex(n => onChain(n.p))
    list.forEach((n, i) => {
      const isLast = i === list.length - 1
      // Siblings above the chain child carry the lit line down to it.
      const lit = chainAt < 0 || i > chainAt ? 0 : i === chainAt ? 1 : 0.6
      const own: Guide = { more: !isLast, lit, op: focusOp }
      const line = depth === 0 ? [] : guideSegs([...guides, own], isLast, own)
      rows.push(n.d ? folderRow(n, depth, fade, line) : fileRow(n, depth, fade, line))
      if (!n.d) return
      const want = wantsOpen(n.p, depth)
      let mem = folders.get(n.p)
      if (mem === undefined) {
        mem = { open: want, at: -Infinity }
        folders.set(n.p, mem)
      } else if (mem.open !== want) {
        mem = { open: want, at: now }
        folders.set(n.p, mem)
      }
      // A child's guide at this level is lit only while the line runs past it.
      const below: Guide = { more: !isLast, lit: chainAt >= 0 && i < chainAt ? 0.6 : 0, op: focusOp }
      const next = depth === 0 ? [] : [...guides, below]
      const since = now - mem.at
      if (mem.open) walk(n.p, depth + 1, Math.max(fade, 1 - smooth(since / T.expand)), next)
      else if (since < T.collapse) walk(n.p, depth + 1, Math.max(fade, smooth(since / T.collapse)), next)
    })
  }

  function folderRow(n: Node, depth: number, fade: number, line: Seg[]): Row {
    const name = baseName(n.p) + '/'
    const open = folders.get(n.p)?.open ?? wantsOpen(n.p, depth)
    const own = activity[n.p]
    const h = heat.get(n.p)
    const ownV = intensityOf(own, now)
    const v = Math.max(h?.v ?? 0, ownV)
    const op = ownV >= (h?.v ?? 0) ? own?.op : h?.op
    const room = columns - 1 - cells(line) - 2 - 3
    if (n.ghost) return { key: n.p, path: n.p, segs: ghostSegs([{ t: ' ' }, ...line], n, name, room) }
    const tone = op ? mix(FOLDER, COLOR[op], Math.min(1, v * 1.2)) : FOLDER
    const segs: Seg[] = [{ t: ' ' }, ...line]
    segs.push({ t: open ? '▾' : '▸', c: op && v > 0.05 ? tone : MUTED }, { t: ' ' })
    segs.push({ t: truncate(name, room), c: tone, b: v > 0.4 })
    if (focusChain.has(n.p) && focusOp) {
      const away = (focus?.split('/').length ?? 1) - n.p.split('/').length
      const strength = Math.pow(0.72, away - 1)
      const glyph = strength > 0.65 ? '●' : strength > 0.4 ? '•' : '·'
      segs.push({ t: ' ' + glyph, c: mix(FAINT, COLOR[focusOp], strength * signal(depth)) })
    } else if (v > 0.05 && op) {
      segs.push({ t: ' ·', c: mix(FAINT, COLOR[op], v) })
    } else if (!open) {
      const count = children.get(n.p)?.length ?? 0
      if (count > 0) segs.push({ t: ` +${count}`, c: FAINT })
    }
    return { key: n.p, path: n.p, segs: fadeIn(segs, fade) }
  }

  function ghostSegs(lead: Seg[], n: Node, name: string, room: number): Seg[] {
    const g = n.ghost as Ghost
    const age = now - g.at
    const col = COLOR.delete
    const segs = [...lead]
    const shown = truncate(name, room)
    if (age < T.ghostHighlight) {
      const k = smooth(age / T.ghostHighlight)
      const bg = mix(TINT.delete, '#8e1519', k)
      segs.push({ t: ICON.delete, c: mix(col, '#ffffff', k), b: true }, { t: ' ', bg }, { t: shown, c: mix(col, '#ffffff', k), bg, b: true })
    } else if (age < T.ghostShake) {
      // A damped shake: big jolts first, settling to still.
      const t = (age - T.ghostHighlight) / (T.ghostShake - T.ghostHighlight)
      const amp = 3 * Math.pow(1 - t, 2)
      const off = Math.round(amp * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 5)))
      const bg = mix('#8e1519', TINT.delete, smooth(t))
      segs.push({ t: ' '.repeat(off) }, { t: ICON.delete, c: col, b: true }, { t: ' ', bg }, { t: truncate(name, room - off), c: mix('#ffffff', HOT.delete, t), bg, b: true })
    } else {
      // Dissolves from the right, each cell dimming before it goes.
      const p = smooth((age - T.ghostShake) / (T.ghostGone - T.ghostShake))
      const chars = [...shown]
      const keep = chars.slice(0, Math.ceil(chars.length * (1 - p))).join('')
      segs.push({ t: p < 0.8 ? ICON.delete : ' ', c: mix(col, FAINT, p) }, { t: ' ' })
      segs.push(...paint(keep, (i, len) => ({ c: mix(col, FAINT, clamp01(p * 1.2 + (i / Math.max(1, len)) * 0.5)), s: true })))
    }
    return segs
  }

  function fileRow(n: Node, depth: number, fade: number, line: Seg[]): Row {
    const name = baseName(n.p)
    const a = activity[n.p]
    const level = n.ghost ? 'none' : levelOf(a, now)
    const isFocus = n.p === focus
    const room = columns - 1 - cells(line) - 2 - (isFocus ? 13 : 1)
    if (n.ghost) return { key: n.p, path: n.p, segs: ghostSegs([{ t: ' ' }, ...line], n, name, room) }
    const shown = truncate(name, room)

    if (a === undefined || level === 'none') {
      return { key: n.p, path: n.p, segs: fadeIn([{ t: ' ' }, ...line, { t: '·', c: FAINT }, { t: ' ' }, { t: shown, c: BASE }], fade) }
    }
    const col = COLOR[a.op]
    const hot = HOT[a.op]

    if (level === 'active') {
      const bg = isFocus ? TINT[a.op] : undefined
      const segs: Seg[] = [isFocus ? { t: '▌', c: mix(col, hot, pulse(now, 1000) * 0.6) } : { t: ' ' }, ...line]
      if (!isFocus) {
        // Running in the background: present, but quiet.
        segs.push({ t: ICON[a.op], c: col }, { t: ' ' }, { t: shown, c: mix(col, BASE, 0.15 + 0.25 * pulse(now, 1800)) })
        return { key: n.p, path: n.p, segs }
      }
      if (a.op === 'view') {
        // A soft band of light scans the name, back and forth.
        const len = [...shown].length
        const at = (len + 4) * (0.5 - 0.5 * Math.cos((now / 1400) * Math.PI)) - 2
        segs.push({ t: ICON.view, c: mix(col, hot, pulse(now, 700) * 0.7), b: true }, { t: ' ', bg })
        segs.push(...paint(shown, i => {
          const k = band(i, at, 2.6)
          return { c: mix(col, hot, k), bg: mix(TINT.view, '#1f6feb', k * 0.8), b: k > 0.5 }
        }))
      } else if (a.op === 'edit') {
        // A ripple runs along the name like keystrokes landing, then a cursor.
        segs.push({ t: ICON.edit, c: mix(col, hot, pulse(now, 520) * 0.8), b: true }, { t: ' ', bg })
        segs.push(...paint(shown, i => ({ c: mix(col, hot, 0.75 * pulse(now, 900, i * 55)), bg, b: true })))
        segs.push({ t: '▏', c: mix(bg ?? FAINT, hot, pulse(now, 1060)), bg })
      } else if (a.op === 'create') {
        const age = now - a.startedAt
        if (age < T.entrance) {
          // The name types itself in, its leading edge bright.
          const p = smooth(age / T.entrance)
          const chars = [...shown]
          const reveal = chars.length * p
          const seed = ['·', '∙', '•', '+'][Math.min(3, Math.floor(p * 4))] ?? '+'
          segs.push({ t: seed, c: mix(FAINT, col, p), b: true }, { t: ' ', bg })
          segs.push(...paint(chars.slice(0, Math.ceil(reveal)).join(''), i => {
            const edge = reveal - i
            return { c: edge < 1 ? mix(TINT.create, hot, edge) : mix(hot, col, clamp01((edge - 1) / 4)), bg, b: true }
          }))
        } else {
          segs.push({ t: ICON.create, c: mix(col, hot, pulse(now, 800) * 0.7), b: true }, { t: ' ', bg })
          segs.push(...paint(shown, i => ({ c: mix(col, hot, 0.6 * pulse(now, 1100, i * 70)), bg: mix(TINT.create, '#196c2e', 0.6 * pulse(now, 1600)), b: true })))
        }
      } else {
        const k = pulse(now, 760)
        const red = mix(TINT.delete, '#8e1519', k)
        segs.push({ t: ICON.delete, c: mix(col, hot, k), b: true }, { t: ' ', bg: red })
        segs.push({ t: shown, c: mix(col, '#ffffff', k * 0.8), bg: red, b: true })
      }
      // A leader flows from the right edge into the file, ending in what Claude is doing.
      const label = ` ${VERB[a.op]} `
      const pad = Math.max(1, columns - cells(segs) - label.length - 1)
      segs.push({ t: ' ', bg })
      segs.push(...paint('╌'.repeat(Math.max(0, pad - 1)), j => ({ c: mix(FAINT, col, 0.15 + 0.6 * pulse(now, 1000, -j * 70)), bg })))
      segs.push({ t: '◂', c: col, bg, b: true })
      segs.push(...paint(label, i => ({ c: mix(col, hot, band(i, ((now / 90) % (label.length + 8)) - 4, 2.2)), bg, b: true })))
      return { key: n.p, path: n.p, segs }
    }

    const age = now - (a.endedAt ?? now)
    const segs: Seg[] = [{ t: ' ' }, ...line]
    if (level === 'done') {
      const p = smooth(age / T.done)
      segs.push({ t: '✓', c: mix(hot, col, p), b: p < 0.6 }, { t: ' ' }, { t: shown, c: mix(hot, mix(col, BASE, 0.15), p), b: p < 0.4 })
    } else if (level === 'recent') {
      const p = smooth((age - T.done) / (T.recent - T.done))
      segs.push({ t: ICON[a.op], c: mix(col, mix(col, FAINT, 0.6), p) }, { t: ' ' }, { t: shown, c: mix(col, BASE, 0.15 + 0.6 * p) })
    } else {
      const p = smooth((age - T.recent) / (T.trail - T.recent))
      segs.push({ t: '✓', c: mix(mix(col, FAINT, 0.6), FAINT, p) }, { t: ' ' }, { t: shown, c: mix(mix(col, BASE, 0.75), BASE, p) })
    }
    return { key: n.p, path: n.p, segs: fadeIn(segs, fade) }
  }

  walk('', 0, 0, [])
  return rows
}

/** Eases the visible window toward keeping the focused row in its upper third. */
export function scrollTo(current: number, rows: readonly Row[], focus: string | undefined, room: number): number {
  const max = Math.max(0, rows.length - room)
  let target = Math.min(current, max)
  const at = focus === undefined ? -1 : rows.findIndex(r => r.path === focus)
  if (at >= 0 && (at < current + 1 || at > current + room - 2)) target = Math.min(max, Math.max(0, at - Math.floor(room / 3)))
  const delta = target - current
  if (delta === 0) return Math.min(current, max)
  const step = Math.max(1, Math.ceil(Math.abs(delta) / 4))
  return current + Math.sign(delta) * Math.min(step, Math.abs(delta))
}

// ---------------------------------------------------------------- chrome

// Glyphs every common monospace font has, so the spark never falls back to a wider font.
const SPARK = ['·', '∙', '•', '◆', '✶', '◆', '•', '∙']

/** `✶ work-map ~/project`, the spark turning while Claude works. */
export function headerLine(now: number, isWorking: boolean, root: string): Seg[] {
  const spark = isWorking ? SPARK[Math.floor(now / 110) % SPARK.length] ?? '✶' : '✶'
  return [
    { t: spark, c: isWorking ? mix(CLAUDE, '#ffd2bf', pulse(now, 900) * 0.6) : CLAUDE, b: true },
    { t: ' work-map', c: BASE, b: true },
    { t: ` ~/${root}`, c: MUTED },
  ]
}

/** The prompt line: what Claude is doing right now, with a live cursor. */
export function statusLine(activity: Readonly<Record<string, Activity>>, turn: TurnInfo, now: number, fileCount: number, columns: number): Seg[] {
  const focus = focusOf(activity)
  const a = focus === undefined ? undefined : activity[focus]
  const cursor = (c: string): Seg => ({ t: '█', c: mix(c, FAINT, pulse(now, 1060)) })
  const shimmer = (text: string, c: string): Seg[] =>
    paint(text, i => ({ c: mix(c, '#ffffff', 0.7 * band(i, ((now / 70) % (text.length + 10)) - 5, 2.5)), b: true }))
  if (a !== undefined && focus !== undefined) {
    const col = COLOR[a.op]
    const others = Object.values(activity).filter(x => x.running > 0).length - 1
    const secs = `${(Math.max(0, now - a.startedAt) / 1000).toFixed(1)}s`
    const dir = parentOf(focus)
    const tail = ` ${secs}${others > 0 ? ` +${others}` : ''}`
    const room = columns - 2 - VERB[a.op].length - 1 - tail.length - 2 // '❯ ', the verb, a space, the tail, ' █'
    const path = truncate(focus, room)
    const cut = dir !== '' && path === focus ? dir.length + 1 : 0
    return [
      { t: '❯ ', c: CLAUDE, b: true },
      ...shimmer(VERB[a.op], col),
      { t: ' ' },
      { t: path.slice(0, cut), c: MUTED },
      { t: path.slice(cut), c: BASE },
      { t: tail, c: MUTED },
      { t: ' ' },
      cursor(col),
    ]
  }
  if (turn.phase === 'working') return [{ t: '❯ ', c: CLAUDE, b: true }, ...shimmer('thinking', MUTED), { t: ' ' }, cursor(MUTED)]
  return [{ t: '❯ ', c: MUTED }, { t: `idle · ${fileCount} files`, c: MUTED }, { t: ' ' }, cursor(MUTED)]
}

export function legendLines(columns: number): Seg[][] {
  const item = (op: Op): Seg[] => [{ t: ICON[op], c: COLOR[op], b: true }, { t: ' ' + LABEL[op], c: MUTED }]
  const gap: Seg = { t: '  ' }
  const one = [...item('view'), gap, ...item('edit'), gap, ...item('create'), gap, ...item('delete')]
  if (cells(one) <= columns) return [one]
  return [
    [...item('view'), gap, ...item('edit')],
    [...item('create'), gap, ...item('delete')],
  ]
}

/** The completion card's lines, bars filling as it enters; none once it has gone. */
export function summaryLines(turn: TurnInfo, now: number, columns = 40): Seg[][] {
  if (turn.phase !== 'complete') return []
  const age = now - turn.at
  if (age > T.summary) return []
  const out = smooth((age - (T.summary - 1500)) / 1500)
  const fadeOut = (s: Seg): Seg => (out > 0 ? { ...s, c: mix(s.c ?? BASE, FAINT, out), b: false } : s)
  const lines: Seg[][] = []
  const head = smooth(age / 450)
  lines.push(paint('✓ TASK COMPLETE', i => ({ c: mix(FAINT, COLOR.create, smooth(head * 1.6 - i / 30)), b: true })))
  const words: Record<Op, string> = { view: 'viewed', edit: 'edited', create: 'created', delete: 'deleted' }
  const most = Math.max(1, ...OPS.map(op => turn.counts[op].length))
  const barWidth = Math.max(4, Math.min(14, columns - 22))
  OPS.forEach((op, i) => {
    const start = 250 + i * 120
    if (age < start) return
    const n = turn.counts[op].length
    const grow = smooth((age - start) / 800)
    const shown = Math.round(n * grow)
    const filled = (barWidth * n * grow) / most
    const whole = Math.floor(filled)
    const bar: Seg[] = paint('━'.repeat(barWidth), j => ({
      c: j < whole ? COLOR[op] : j === whole && filled > whole ? mix(FAINT, COLOR[op], filled - whole) : FAINT,
    }))
    lines.push([
      { t: ICON[op] + ' ', c: n > 0 ? COLOR[op] : FAINT, b: true },
      { t: words[op].padEnd(8), c: n > 0 ? BASE : MUTED },
      { t: String(shown).padStart(3) + ' ', c: n > 0 ? COLOR[op] : MUTED, b: n > 0 },
      ...bar,
    ])
  })
  return lines.map(l => l.map(fadeOut))
}

export function emptyTurn(): TurnInfo {
  return { phase: 'idle', at: 0, counts: { view: [], edit: [], create: [], delete: [] } }
}

export function counted(turn: TurnInfo, op: Op, path: string): TurnInfo {
  if (turn.counts[op].includes(path)) return turn
  return { ...turn, counts: { ...turn.counts, [op]: [...turn.counts[op], path] } }
}
