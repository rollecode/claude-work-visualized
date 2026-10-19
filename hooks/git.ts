// The git view: Claude's git and gh commands drawn on a small branch graph.
// Pure, like model.ts: register.tsx runs git and hands its output here.

import type { GitAction, GitKind, GitRow, GitState } from '../types'
import { BASE, CLAUDE, COLOR, FAINT, MUTED, mix } from './model'
import type { Seg } from './model'

export const GIT_LINGER = 60_000 // the view stays this long after the last git command
const GIT_FADE = 1500
const POP = 700 // a new commit's dot grows in over this long
const LABEL_FADE = 20_000 // the action's label fades back to muted over this long
const LIT = 3000 // merge and rebase light the graph's lines this long
const MAX_COMMITS = 8
const MAX_REFS = 3
const PURPLE = '#bc8cff'
const TAG = '#d29922'

const KIND_COLOR: Record<GitKind, string> = {
  checkout: COLOR.view,
  branch: COLOR.create,
  commit: COLOR.create,
  merge: PURPLE,
  rebase: COLOR.edit,
  push: COLOR.edit,
  pull: COLOR.view,
  fetch: COLOR.view,
  reset: COLOR.delete,
  pr: COLOR.create,
  'pr-merge': PURPLE,
}
// One terminal cell each, from glyphs common monospace fonts have.
const KIND_GLYPH: Record<GitKind, string> = {
  checkout: '→',
  branch: '+',
  commit: '+',
  merge: '◆',
  rebase: '◆',
  push: '↑',
  pull: '↓',
  fetch: '↓',
  reset: '←',
  pr: '#',
  'pr-merge': '◆',
}
const KIND_VERB: Record<GitKind, string> = {
  checkout: 'checkout',
  branch: 'branch',
  commit: 'commit',
  merge: 'merge',
  rebase: 'rebase',
  push: 'push',
  pull: 'pull',
  fetch: 'fetch',
  reset: 'reset',
  pr: 'pull request',
  'pr-merge': 'merge PR',
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const smooth = (t: number) => {
  const k = clamp01(t)
  return k * k * (3 - 2 * k)
}
const pulse = (now: number, period: number, phase = 0) => (Math.sin(((now - phase) / period) * Math.PI * 2) + 1) / 2

// ---------------------------------------------------------------- commands

const SEPARATORS = /&&|\|\||;|\||\n/
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time'])
const GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The git and gh commands in a shell command that change branches, commits or remotes. */
export function gitActionsOf(command: string): GitAction[] {
  const out: GitAction[] = []
  for (const segment of command.split(SEPARATORS)) {
    let w = words(segment.trim())
    while (w[0] !== undefined && (/^\w+=/.test(w[0]) || PREFIXES.has(w[0]))) w = w.slice(1)
    const action = w[0] === 'git' ? gitAction(w.slice(1)) : w[0] === 'gh' ? ghAction(w.slice(1)) : undefined
    if (action !== undefined) out.push(action)
  }
  return out
}

function gitAction(args: readonly string[]): GitAction | undefined {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += GLOBALS_WITH_VALUE.has(args[i] ?? '') ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  const first = rest.find(a => !a.startsWith('-'))
  const has = (...flags: string[]) => rest.some(a => flags.includes(a))
  switch (sub) {
    case 'checkout':
    case 'switch': {
      const at = rest.findIndex(a => ['-b', '-B', '-c', '-C'].includes(a))
      if (at >= 0) return { kind: 'checkout', ref: rest[at + 1] }
      // `checkout -- file` restores files; it moves no branch.
      if (has('--') || first === undefined) return undefined
      return { kind: 'checkout', ref: first }
    }
    case 'branch':
      if (first === undefined || has('-d', '-D', '--delete', '-m', '-M', '--move', '--list', '-l')) return undefined
      return { kind: 'branch', ref: first }
    case 'commit':
    case 'cherry-pick':
    case 'revert':
      return { kind: 'commit' }
    case 'merge':
    case 'rebase':
      if (has('--abort', '--quit')) return undefined
      return { kind: sub, ...(first === undefined ? {} : { ref: first }) }
    case 'push':
    case 'pull':
    case 'fetch':
    case 'reset':
      return { kind: sub, ...(first === undefined ? {} : { ref: first }) }
    default:
      return undefined
  }
}

function ghAction(args: readonly string[]): GitAction | undefined {
  if (args[0] !== 'pr') return undefined
  if (args[1] === 'create') return { kind: 'pr' }
  if (args[1] === 'merge') {
    const n = args.slice(2).find(a => /^#?\d+$/.test(a))
    return { kind: 'pr-merge', ...(n === undefined ? {} : { ref: n.replace('#', '') }) }
  }
  return undefined
}

/** The branches to draw beside HEAD after an action: the one it named, and where a checkout came from. */
export function refsAfter(refs: readonly string[], action: GitAction, before: string): string[] {
  const named = action.kind === 'checkout' ? [before] : ['merge', 'rebase', 'branch'].includes(action.kind) && action.ref ? [action.ref] : []
  const out = [...named, ...refs.filter(r => !named.includes(r))].filter(r => r !== '' && !r.startsWith('-'))
  return out.slice(0, MAX_REFS)
}

/** The PR number a `gh pr` command printed, from its URL. */
export function prNumberOf(stdout: string): number | undefined {
  const m = /\/pull\/(\d+)/.exec(stdout)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** The base branch a `gh pr create` names with `--base` or `-B`. */
export function prBaseOf(command: string): string | undefined {
  const w = words(command)
  const at = w.findIndex(a => a === '--base' || a === '-B')
  return at >= 0 ? w[at + 1] : w.find(a => a.startsWith('--base='))?.slice('--base='.length)
}

// ---------------------------------------------------------------- reading git

/** `git log --graph` for HEAD and the given branches, one record per commit row. */
export function graphArgv(refs: readonly string[]): string[] {
  return ['git', '--no-pager', 'log', '--graph', '--no-color', '--pretty=format:%x1e%h%x1f%D%x1f%s', '-n', String(MAX_COMMITS), 'HEAD', ...refs, '--']
}

export const AHEAD_ARGV = ['git', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}']

const GRAPH_GLYPH: Record<string, string> = { '*': '●', '|': '│', '/': '╱', '\\': '╲', '_': '─', '-': '─', '.': '·' }

export function parseGraph(stdout: string): GitRow[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const at = line.indexOf('\x1e')
      const graph = [...(at < 0 ? line : line.slice(0, at))].map(c => GRAPH_GLYPH[c] ?? c).join('').trimEnd()
      if (at < 0) return { graph }
      const [hash = '', deco = '', subject = ''] = line.slice(at + 1).split('\x1f')
      const refs: string[] = []
      let isHead = false
      for (const r of deco.split(', ').filter(x => x !== '')) {
        if (r === 'HEAD') isHead = true
        else if (r.startsWith('HEAD -> ')) {
          isHead = true
          refs.unshift(r.slice('HEAD -> '.length))
        } else refs.push(r.replace(/^tag: /, '#'))
      }
      return { graph, hash, refs, subject, isHead }
    })
}

/** The checked-out branch, or the commit when detached. */
export function headOf(rows: readonly GitRow[]): string {
  const row = rows.find(r => r.isHead)
  return row?.refs?.[0] ?? row?.hash ?? ''
}

// ---------------------------------------------------------------- state

export function gitStarted(state: GitState | null, action: GitAction, now: number): GitState {
  const { endedAt: _ended, isFailed: _failed, ...base } = state ?? { rows: [], head: '', refs: [], fresh: [], at: now }
  return { ...base, action, at: now }
}

export type GitRead = { rows: GitRow[]; ahead?: number; behind?: number }

export function gitEnded(state: GitState, read: GitRead | undefined, refs: string[], isFailed: boolean, now: number): GitState {
  if (read === undefined) return { ...state, endedAt: now, isFailed }
  const had = new Set(state.rows.map(r => r.hash).filter(h => h !== undefined))
  const fresh = had.size === 0 ? [] : read.rows.map(r => r.hash).filter((h): h is string => h !== undefined && !had.has(h))
  const { ahead: _ahead, behind: _behind, ...rest } = state
  const counts = { ...(read.ahead === undefined ? {} : { ahead: read.ahead }), ...(read.behind === undefined ? {} : { behind: read.behind }) }
  return { ...rest, ...counts, rows: read.rows, head: headOf(read.rows), refs, fresh, endedAt: now, isFailed }
}

/** 0 while the view is shown, rising to 1 as it fades out a while after the last command. */
export function gitFade(state: GitState | null, now: number): number {
  if (state === null || state.rows.length === 0) return 1
  if (state.endedAt === undefined) return 0
  return smooth((now - state.endedAt - GIT_LINGER) / GIT_FADE)
}

// ---------------------------------------------------------------- drawing

export type GitView = { lines: Seg[][]; label: string; fade: number }

/** Cuts a row to `width` cells, ending in `…` when anything was cut. */
function fit(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let left = width
  for (const s of segs) {
    const chars = [...s.t]
    if (chars.length <= left) {
      out.push(s)
      left -= chars.length
      continue
    }
    if (left > 0) out.push({ ...s, t: chars.slice(0, Math.max(0, left - 1)).join('') + '…' })
    break
  }
  return out
}

function shimmer(text: string, c: string, now: number): Seg[] {
  const chars = [...text]
  const at = ((now / 70) % (chars.length + 10)) - 5
  return chars.map((t, i) => ({ t, c: mix(c, '#ffffff', 0.6 * smooth(1 - Math.abs(i - at) / 2.5)), b: true }))
}

/** The action's label on the HEAD row: shimmering while it runs, fading after. */
function actionLabel(state: GitState, now: number): Seg[] {
  const action = state.action
  if (action === undefined) return []
  const verb = action.kind === 'pr-merge' && action.ref ? `merge PR #${action.ref}` : `${KIND_VERB[action.kind]}${action.ref && action.kind !== 'pr-merge' ? ` ${action.ref}` : ''}`
  const col = KIND_COLOR[action.kind]
  if (state.endedAt === undefined) return [{ t: '◂ ', c: col, b: true }, { t: KIND_GLYPH[action.kind] + ' ', c: col, b: true }, ...shimmer(verb, col, now)]
  const age = now - state.endedAt
  if (state.isFailed) return [{ t: '✗ ' + verb, c: mix(COLOR.delete, MUTED, smooth(age / LABEL_FADE)) }]
  const c = mix(col, MUTED, smooth(age / LABEL_FADE))
  return [{ t: KIND_GLYPH[action.kind] + ' ' + verb, c, b: age < 2000 }]
}

function graphSegs(row: GitRow, state: GitState, now: number, rowIndex: number): Seg[] {
  const since = state.endedAt === undefined ? 0 : now - state.endedAt
  const kind = state.action?.kind
  const isLit = (kind === 'merge' || kind === 'rebase' || kind === 'pr-merge') && state.endedAt !== undefined && since < LIT && rowIndex < 4
  const isFresh = row.hash !== undefined && state.fresh.includes(row.hash) && since < POP + 1500
  return [...row.graph].map((g): Seg => {
    if (g === '●' && row.isHead) {
      const running = state.endedAt === undefined
      return { t: '◉', c: running ? mix(CLAUDE, '#ffd2bf', pulse(now, 700) * 0.7) : CLAUDE, b: true }
    }
    if (g === '●' && isFresh) {
      const p = smooth(since / POP)
      return { t: ['·', '∙', '•', '●'][Math.min(3, Math.floor(p * 4))] ?? '●', c: mix('#d2f8dc', COLOR.create, p), b: true }
    }
    if (g === '●') return { t: g, c: MUTED }
    if (g === ' ') return { t: g }
    return { t: g, c: isLit && kind ? mix(FAINT, KIND_COLOR[kind], (1 - since / LIT) * (0.5 + 0.5 * pulse(now, 600))) : FAINT }
  })
}

function refSegs(row: GitRow): Seg[] {
  const out: Seg[] = []
  for (const r of row.refs ?? []) {
    const isHeadRef = row.isHead === true && r === row.refs?.[0]
    const c = r.startsWith('#') ? TAG : r.includes('/') ? MUTED : isHeadRef ? BASE : COLOR.view
    out.push({ t: r, c, b: isHeadRef }, { t: ' ' })
  }
  return out
}

function prLines(state: GitState, now: number, width: number): Seg[][] {
  const pr = state.pr
  if (pr === undefined || width < 12) return []
  const col = pr.state === 'merged' ? PURPLE : COLOR.create
  const edge = mix(FAINT, col, smooth((now - pr.at) / 500))
  const title = ` #${pr.number} ${pr.state} `
  const body = `${pr.head} → ${pr.base ?? 'default branch'}`
  const inner = width - 5
  const shown = [...body].length > inner ? [...body].slice(0, inner - 1).join('') + '…' : body
  return [
    [{ t: ' ╭─', c: edge }, { t: title, c: col, b: true }, { t: '─'.repeat(Math.max(0, width - 3 - [...title].length - 1)) + '╮', c: edge }],
    [{ t: ' │ ', c: edge }, { t: shown, c: BASE }, { t: ' '.repeat(Math.max(0, inner - [...shown].length)) + ' │', c: edge }],
    [{ t: ' ╰' + '─'.repeat(Math.max(0, width - 3)) + '╯', c: edge }],
  ]
}

/** The graph rows (at most `rows`), the action's label on HEAD, and the PR card. */
export function gitView(state: GitState | null, now: number, columns: number, rows: number): GitView {
  const fade = gitFade(state, now)
  if (state === null || fade >= 1) return { lines: [], label: '', fade: 1 }
  const width = columns - 1
  const faded = (segs: Seg[]) => (fade > 0 ? segs.map(s => (s.c === undefined ? s : { ...s, c: mix(s.c, FAINT, fade), b: false })) : segs)
  const card = prLines(state, now, width)
  const room = Math.max(1, rows - card.length)
  const lines = state.rows.slice(0, room).map((row, i) => {
    const lead: Seg[] = [{ t: ' ' }, ...graphSegs(row, state, now, i), { t: ' ' }]
    if (row.hash === undefined) return faded(fit(lead, width))
    const text: Seg[] = [...refSegs(row), { t: row.subject ?? '', c: row.isHead ? MUTED : mix(MUTED, FAINT, 0.3) }]
    if (!row.isHead) return faded(fit([...lead, ...text], width))
    const label = actionLabel(state, now)
    const labelCells = label.reduce((n, s) => n + [...s.t].length, 0)
    const left = fit([...lead, ...text], Math.max(0, width - labelCells - 1))
    const used = left.reduce((n, s) => n + [...s.t].length, 0)
    return faded(fit([...left, { t: ' '.repeat(Math.max(1, width - used - labelCells)) }, ...label], width))
  })
  const counts = `${state.ahead ? ` ${state.ahead} ahead` : ''}${state.behind ? ` ${state.behind} behind` : ''}`
  return { lines: [...lines, ...card.map(faded)], label: `git ${state.head}${counts}`, fade }
}
