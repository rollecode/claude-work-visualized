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
const PR_CARD = 20_000 // the PR card shows this long after a PR opens or merges, then only the rule names it
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
// What the prompt line says while the command runs.
const KIND_DOING: Record<GitKind, string> = {
  checkout: 'checking out',
  branch: 'branching',
  commit: 'committing',
  merge: 'merging',
  rebase: 'rebasing',
  push: 'pushing',
  pull: 'pulling',
  fetch: 'fetching',
  reset: 'resetting',
  pr: 'opening PR',
  'pr-merge': 'merging PR',
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

const PREFIXES = new Set(['sudo', 'command', 'exec', 'time'])
const GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** A command split on `&&`, `||`, `;`, `|` and new lines outside quotes. */
function segmentsOf(command: string): string[] {
  const out: string[] = []
  let text = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') {
        text += ch + (command[++i] ?? '')
        continue
      }
      if (ch === quote) quote = undefined
      text += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      text += ch
    } else if (ch === ';' || ch === '|' || ch === '\n' || (ch === '&' && command[i + 1] === '&')) {
      if (command[i + 1] === ch) i++
      out.push(text)
      text = ''
    } else text += ch
  }
  out.push(text)
  return out.filter(s => s.trim() !== '')
}

function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The git and gh commands in a shell command that change branches, commits or remotes, with where each ran. */
export function gitActionsOf(command: string): GitAction[] {
  const out: GitAction[] = []
  // What `cd` and `NAME=value` set earlier in the command, for the commands after them.
  let dir: string | undefined
  const vars = new Map<string, string>()
  const expand = (w: string) => w.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, braced?: string, bare?: string) => vars.get(braced ?? bare ?? '') ?? all)
  const join = (to: string) => (to.includes('$') || dir === '?' ? '?' : dir === undefined || to.startsWith('/') || to.startsWith('~') ? to : `${dir}/${to}`)
  for (const segment of segmentsOf(command)) {
    let w = words(segment.trim()).map(expand)
    while (w[0] !== undefined && (/^\w+=/.test(w[0]) || PREFIXES.has(w[0]))) {
      const set = /^(\w+)=(.*)$/.exec(w[0])
      if (set) vars.set(set[1] ?? '', set[2] ?? '')
      w = w.slice(1)
    }
    if (w[0] === 'cd') {
      dir = w[1] === undefined ? '~' : join(w[1])
      continue
    }
    const action = w[0] === 'git' ? gitAction(w.slice(1), command) : w[0] === 'gh' ? ghAction(w.slice(1)) : undefined
    if (action === undefined) continue
    const where = action.dir === undefined ? dir : join(action.dir)
    out.push({ ...action, ...(where === undefined ? {} : { dir: where }) })
  }
  return out
}

/** A commit's message: `-m msg`, `--message=msg`, or the first line of a `-m "$(cat <<EOF …)"` heredoc. */
function messageOf(args: readonly string[], command: string): string | undefined {
  const heredoc = /-m\s+"\$\(cat\s+<<-?\s*'?(\w+)'?\s*\n\s*([^\n]*)/.exec(command)?.[2]
  if (heredoc !== undefined) return heredoc.trim()
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-m' || a === '--message' || /^-[a-zA-Z]*m$/.test(a)) return args[i + 1]?.split('\n')[0]
    const inline = /^(?:--message=|-m)(.+)$/.exec(a)
    if (inline) return inline[1]?.split('\n')[0]
  }
  return undefined
}

function gitAction(args: readonly string[], command: string): GitAction | undefined {
  let i = 0
  let dir: string | undefined
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    if (args[i] === '-C') dir = args[i + 1]
    i += GLOBALS_WITH_VALUE.has(args[i] ?? '') ? 2 : 1
  }
  const action = subAction(args[i], args.slice(i + 1), command)
  return action === undefined || dir === undefined ? action : { ...action, dir }
}

function subAction(sub: string | undefined, rest: readonly string[], command: string): GitAction | undefined {
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
    case 'commit': {
      const message = messageOf(rest, command)
      return { kind: 'commit', ...(message === undefined || message === '' ? {} : { message }) }
    }
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

const RANK: Record<GitKind, number> = {
  commit: 3, merge: 3, rebase: 3, push: 3, pr: 3, 'pr-merge': 3,
  checkout: 2, branch: 2, reset: 2,
  pull: 1, fetch: 1,
}

/** The action a command is shown as: the weightiest, the last of those when there are several. */
export function mainAction(actions: readonly GitAction[]): GitAction | undefined {
  return actions.reduce<GitAction | undefined>((best, a) => (best === undefined || RANK[a.kind] >= RANK[best.kind] ? a : best), undefined)
}

/** The repository a command ran in, from the session's folder; undefined when a variable hides it. */
export function repoDir(dir: string | undefined, cwd: string, home: string | undefined): string | undefined {
  const root = cwd.replace(/\/+$/, '')
  if (dir === undefined) return root
  if (dir === '?' || (dir.startsWith('~') && home === undefined)) return undefined
  const full = dir.startsWith('~') ? `${home}${dir.slice(1)}` : dir.startsWith('/') ? dir : `${root}/${dir}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
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

/** A command starts in repository `dir`: another repository than the last one starts the view over. */
export function gitStarted(state: GitState | null, action: GitAction, now: number, dir: string): GitState {
  const fresh: GitState = { rows: [], dir, head: '', refs: [], fresh: [], at: now }
  const { endedAt: _ended, isFailed: _failed, ...base } = state === null || state.dir !== dir ? fresh : state
  return { ...base, action, at: now, fresh: [] }
}

export type GitRead = { rows: GitRow[]; ahead?: number; behind?: number }

/** The graph read again, mid-command or after it; commits it didn't have are added to the fresh ones. */
export function gitRead(state: GitState, read: GitRead): GitState {
  const had = new Set(state.rows.map(r => r.hash).filter(h => h !== undefined))
  const added = had.size === 0 ? [] : read.rows.map(r => r.hash).filter((h): h is string => h !== undefined && !had.has(h))
  const { ahead: _ahead, behind: _behind, ...rest } = state
  const counts = { ...(read.ahead === undefined ? {} : { ahead: read.ahead }), ...(read.behind === undefined ? {} : { behind: read.behind }) }
  return { ...rest, ...counts, rows: read.rows, head: headOf(read.rows), fresh: [...state.fresh, ...added] }
}

export function gitEnded(state: GitState, read: GitRead | undefined, refs: string[], isFailed: boolean, now: number): GitState {
  const base = read === undefined ? state : gitRead(state, read)
  return { ...base, refs, endedAt: now, isFailed }
}

/** 0 while the view is shown, rising to 1 as it fades out a while after the last command. */
export function gitFade(state: GitState | null, now: number): number {
  if (state === null || state.rows.length === 0) return 1
  if (state.endedAt === undefined) return 0
  return smooth((now - state.endedAt - GIT_LINGER) / GIT_FADE)
}

/** The running git command as the prompt line names it, in the action's colour. */
export type GitDoing = { verb: string; text: string; color: string; at: number }

export function gitDoingOf(state: GitState | null): GitDoing | undefined {
  const action = state?.action
  if (state === null || action === undefined || state.endedAt !== undefined) return undefined
  const text = action.message ?? (action.kind === 'pr-merge' && action.ref ? `#${action.ref}` : action.ref) ?? state.head
  return { verb: KIND_DOING[action.kind], text, color: KIND_COLOR[action.kind], at: state.at }
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
  if (pr === undefined || width < 12 || now - pr.at > PR_CARD) return []
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

/** The commit being made, above HEAD while `git commit` runs: its message, shimmering green. */
function pendingRow(state: GitState, now: number, width: number): Seg[] | undefined {
  const action = state.action
  if (action?.kind !== 'commit' || state.endedAt !== undefined || state.rows.length === 0) return undefined
  const label = actionLabel(state, now)
  const cells = label.reduce((n, s) => n + [...s.t].length, 0)
  const lead: Seg[] = [{ t: ' ' }, { t: '○', c: mix(COLOR.create, '#d2f8dc', pulse(now, 700)), b: true }, { t: ' ' }]
  const left = fit([...lead, ...shimmer(action.message ?? 'new commit', COLOR.create, now)], Math.max(0, width - cells - 1))
  const used = left.reduce((n, s) => n + [...s.t].length, 0)
  return fit([...left, { t: ' '.repeat(Math.max(1, width - used - cells)) }, ...label], width)
}

/** Whether pull requests show: `/prs` hides them. */
export type PrShown = 'shown' | 'hidden'

/** The graph rows (at most `rows`), the action's label on HEAD, and the PR card; `root` is the session's folder. */
export function gitView(state: GitState | null, now: number, columns: number, rows: number, root = '', prs: PrShown = 'shown'): GitView {
  const fade = gitFade(state, now)
  if (state === null || fade >= 1) return { lines: [], label: '', fade: 1 }
  const width = columns - 1
  const faded = (segs: Seg[]) => (fade > 0 ? segs.map(s => (s.c === undefined ? s : { ...s, c: mix(s.c, FAINT, fade), b: false })) : segs)
  const card = prs === 'shown' ? prLines(state, now, width) : []
  const pending = pendingRow(state, now, width)
  const room = Math.max(1, rows - card.length - (pending === undefined ? 0 : 1))
  const since = state.endedAt === undefined ? 0 : now - state.endedAt
  const lines = state.rows.slice(0, room).map((row, i) => {
    const lead: Seg[] = [{ t: ' ' }, ...graphSegs(row, state, now, i), { t: ' ' }]
    if (row.hash === undefined) return faded(fit(lead, width))
    // A commit that just landed keeps its subject green for a while.
    const isFresh = state.fresh.includes(row.hash) && since < LABEL_FADE
    const tone = isFresh ? mix(COLOR.create, MUTED, smooth(since / LABEL_FADE)) : row.isHead ? MUTED : mix(MUTED, FAINT, 0.3)
    const text: Seg[] = [...refSegs(row), { t: row.subject ?? '', c: tone, b: isFresh && since < 2000 }]
    if (!row.isHead || pending !== undefined) return faded(fit([...lead, ...text], width))
    const label = actionLabel(state, now)
    const labelCells = label.reduce((n, s) => n + [...s.t].length, 0)
    const left = fit([...lead, ...text], Math.max(0, width - labelCells - 1))
    const used = left.reduce((n, s) => n + [...s.t].length, 0)
    return faded(fit([...left, { t: ' '.repeat(Math.max(1, width - used - labelCells)) }, ...label], width))
  })
  const counts = `${state.ahead ? ` ${state.ahead} ahead` : ''}${state.behind ? ` ${state.behind} behind` : ''}`
  const name = state.dir.replace(/\/+$/, '') === root.replace(/\/+$/, '') ? '' : ` ${state.dir.replace(/\/+$/, '').split('/').pop() ?? ''}`
  const pr = prs === 'shown' && state.pr !== undefined ? ` · #${state.pr.number} ${state.pr.state}` : ''
  return { lines: [...(pending === undefined ? [] : [faded(pending)]), ...lines, ...card.map(faded)], label: `git${name} ${state.head}${counts}${pr}`, fade }
}
