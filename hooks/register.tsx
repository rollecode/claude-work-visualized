import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, Clip, Ghost, GitAction, GitState, Op, Thought, TreeEntry, TurnInfo } from '../types'
import {
  HOLD, MAX_BYTES, WHEEL_LINES, browseAfter, clipKey, clipOf, codeLines, codeRule, currentClip, enqueue, fileLines, isClipDone, isOverCode, patchStats,
} from './code'
import type { Browse, CodeArea } from './code'
import {
  AHEAD_ARGV, gitActionsOf, gitDoingOf, gitEnded, gitFade, gitRead, gitStarted, gitView, graphArgv, mainAction, parseGraph, prBaseOf, prNumberOf, refsAfter,
  repoDir,
} from './git'
import type { GitRead, PrShown } from './git'
import {
  CLAUDE, COLOR, FAINT, ICON, IGNORED, LABEL, MUTED, T,
  baseName, buildRows, classifyBash, counted, doingOf, mentionsOf, diffTrees, emptyTurn, focusOf, headerLine, isAnimating, isUnscanned, legendLines, mix, remoteOf,
  placeOf, remotePath, scrollTo, staleKeys, statusLine, summaryLines, thoughtRows, thoughtView, typeTo, withPath, withThought, withoutPath,
} from './model'
import type { FolderMemory, Seg, Target } from './model'

const PANE = 'work-map'
const TITLE = 'Claude Work'
const MAX_ENTRIES = 2000
const MAX_DEPTH = 12
const FRAME_MS = 33 // ~30 fps while anything moves, the terminal's cap for a shown pane
const POLL_MS = 1500 // how often the project is rescanned for changes made outside tool calls
const SPLIT_COLUMNS = 84 // from this wide thinking, git and the code view sit beside the tree, else above and under it
const EDITORS = new Set(['Edit', 'MultiEdit', 'Write'])
const MAX_REPLAYS = 4 // files of one tool call the code view checks and replays
const MAX_MATCHES = 40 // files one glob or one tool's output lights up
const PROGRESS_MS = 400 // how often a running copy's destination is measured
const OUTPUT_LISTERS = new Set(['Bash', 'Grep', 'Glob', 'LS']) // tools whose output lines start with file paths
/** How an edit's result shows in the chat: one line while the pane replays it, or the full diff. */
type ChatDiffs = 'quiet' | 'full'

const tree = atom({ plugin: 'work-visualized', key: 'tree' } as const, [] as TreeEntry[])
const activity = atom({ plugin: 'work-visualized', key: 'activity' } as const, {} as Record<string, Activity>)
const ghosts = atom({ plugin: 'work-visualized', key: 'ghosts' } as const, {} as Record<string, Ghost>)
const turn = atom({ plugin: 'work-visualized', key: 'turn' } as const, emptyTurn())
const watching = atom({ plugin: 'work-visualized', key: 'watching' } as const, true)
const clips = atom({ plugin: 'work-visualized', key: 'clips' } as const, [] as Clip[])
const thought = atom({ plugin: 'work-visualized', key: 'thought' } as const, null as Thought | null)
const git = atom({ plugin: 'work-visualized', key: 'git' } as const, null as GitState | null)

// Drawing memory only: a reload starts these over, harmlessly.
const folders: FolderMemory = new Map()
let scroll = 0
let codeScroll = 0
let browse: Browse | undefined // the person scrolling through the edited file
let codeArea: CodeArea | undefined // where the code view was drawn last frame
let shownClip: Clip | undefined
let typed = { key: '', n: 0, at: 0 } // how far the typewriter has got through the thought
let thinkBrowse: Browse | undefined // the person scrolling back through the thought
let thinkArea: CodeArea | undefined // where the thinking section was drawn last frame
let thinkTop = 0 // the thought's first line shown last frame
let animateUntil = 0
let isWatching = true // mirrors the watching atom for synchronous checks
let home: string | undefined
let chatDiffs: ChatDiffs = 'quiet'
let prs: PrShown = 'shown'
let scanning: Promise<unknown> = Promise.resolve()
let lastListed: ReadonlySet<string> = new Set() // folders the last scan listed in full
let changingCalls = 0 // tool calls that can change files, running now

/** The project's paths, and the folders listed in full: not cut off by the limit, nor failed. */
async function scanTree($: EngineInterface): Promise<{ entries: TreeEntry[]; listed: Set<string> }> {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const out: TreeEntry[] = []
  const listed = new Set<string>()
  let level: string[] = ['']
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && out.length < MAX_ENTRIES; depth++) {
    const next: string[] = []
    const lists = await Promise.all(level.map(dir => $.fs.list(dir === '' ? cwd : `${cwd}/${dir}`).catch(() => undefined)))
    level.forEach((dir, i) => {
      const list = lists[i]
      if (list === undefined) return
      let isWhole = true
      for (const entry of list) {
        if (IGNORED.has(entry.name)) continue
        if (out.length >= MAX_ENTRIES) {
          isWhole = false
          break
        }
        const p = dir === '' ? entry.name : `${dir}/${entry.name}`
        const d = entry.kind === 'dir'
        out.push({ p, d, m: entry.mtimeMs })
        if (d) next.push(p)
      }
      if (isWhole) listed.add(dir)
    })
    level = next
  }
  return { entries: out, listed }
}

/** Rescans the project and animates whatever changed that no tool call named. */
/** Why a rescan runs: right after a tool call that can change files, or the timer and other upkeep. */
type ScanCause = 'tool' | 'poll'

function rescan($: EngineInterface, claimed: ReadonlySet<string>, cause: ScanCause): Promise<unknown> {
  scanning = scanning.then(async () => {
    // Claude's doing: after its tool call, or while one still runs (a long build).
    const isClaudes = cause === 'tool' || changingCalls > 0
    const scan = await scanTree($)
    const fresh = scan.entries
    // Remote paths come from commands, not the scan, so they are kept as they are.
    const before = (await read($, tree)).filter(t => !isUnscanned(t.p))
    const now = await $.clock.now()
    const diff = diffTrees(before, fresh, { before: lastListed, after: scan.listed })
    lastListed = scan.listed
    // Keep entries a running create put in early, so they don't blink out.
    const running = await read($, activity)
    const busy = new Set([...claimed, ...Object.keys(running).filter(p => (running[p]?.running ?? 0) > 0)])
    let merged = fresh
    for (const [p, a] of Object.entries(running)) {
      if (a.running > 0 && a.op === 'create' && !isUnscanned(p)) merged = withPath(merged, p, false)
    }
    await update($, tree, list => [...merged, ...list.filter(t => isUnscanned(t.p))])
    if (before.length === 0) return // the first map of the project is no activity
    const born = diff.created.filter(t => !busy.has(t.p))
    const changed = diff.edited.filter(p => !busy.has(p))
    const gone = diff.deleted.filter(t => !running[t.p] || running[t.p]?.op !== 'create')
    if (born.length + changed.length + gone.length === 0) return
    await update($, activity, map => {
      const out = { ...map }
      for (const t of born) out[t.p] = { op: 'create', startedAt: now, endedAt: now, running: 0 }
      for (const p of changed) out[p] = { op: 'edit', startedAt: now, endedAt: now, running: 0 }
      for (const t of gone) delete out[t.p]
      return out
    })
    if (gone.length > 0) {
      await update($, ghosts, map => {
        const out = { ...map }
        for (const t of gone.slice(0, 40)) out[t.p] = { d: t.d, at: now }
        return out
      })
    }
    // Only Claude's own changes count on the turn's card; others still animate in the tree.
    await update($, turn, info => {
      if (info.phase !== 'working' || !isClaudes) return info
      let t = info
      for (const e of born) t = counted(t, 'create', e.p)
      for (const p of changed) t = counted(t, 'edit', p)
      for (const e of gone) t = counted(t, 'delete', e.p)
      return t
    })
    animateUntil = now + T.trail + 2000
  }).catch(() => undefined)
  return scanning
}

/** A tool call's path: where it sits in the tree, and the file on disk when it is on this machine. */
type Located = Target & { file?: string }

/** The paths a tool call touches, and how, as tree paths. */
async function targetsOf($: EngineInterface, tool: string, input: Record<string, unknown>, cwd: string): Promise<Located[]> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if ((await read($, tree)).length === 0) await scanning
  const known = new Set((await read($, tree)).map(t => t.p))
  const isThere = async (place: { file: string; path: string }) => known.has(place.path) || (await $.fs.stat(place.file).then(() => true, () => false))
  const resolve = async (raw: string | undefined, op: Op): Promise<Located[]> => {
    if (raw !== undefined && /[*?[]/.test(raw)) return (await Promise.all((await globbed($, cwd, raw)).map(p => resolve(p, op)))).flat()
    const place = raw === undefined ? undefined : placeOf(cwd, raw, home)
    if (place === undefined) return []
    if (tool !== 'Bash' && tool !== 'Write') return [{ op, ...place }]
    // A shell word that names no file is most likely not a path; writing one that isn't there is a create.
    if (await isThere(place)) return [{ op, ...place }]
    return op === 'edit' || op === 'create' ? [{ op: 'create', ...place }] : []
  }
  switch (tool) {
    case 'Read':
      return resolve(str('file_path'), 'view')
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return resolve(str('file_path'), 'edit')
    case 'NotebookEdit':
      return resolve(str('notebook_path'), 'edit')
    case 'Glob':
    case 'Grep':
    case 'LS':
      return resolve(str('path') ?? cwd + '/.', 'view')
    case 'Bash': {
      const found = await Promise.all(classifyBash(str('command') ?? '').map(async (t): Promise<Located[]> => {
        if (t.host === undefined) return resolve(t.path, t.op)
        const path = remotePath(t.host, t.path)
        return path === undefined ? [] : [{ op: t.op, path }]
      }))
      return found.flat()
    }
    default:
      return []
  }
}

/** What a glob in a path's last part matches, as the shell would: dotfiles only for a pattern that starts with a dot. */
async function globbed($: EngineInterface, cwd: string, raw: string): Promise<string[]> {
  const dir = raw.slice(0, raw.lastIndexOf('/') + 1)
  const pattern = raw.slice(dir.length)
  if (/[*?[]/.test(dir)) return []
  const at = dir === '' || dir === './' ? cwd : placeOf(cwd, dir, home)?.file
  if (at === undefined) return []
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  const entries = await $.fs.list(at).catch(() => [])
  return entries
    .filter(x => re.test(x.name) && (!x.name.startsWith('.') || pattern.startsWith('.')))
    .slice(0, MAX_MATCHES)
    .map(x => dir + x.name)
}

/** Files a tool's output names, one per line as grep, find or Glob print them, that the tree already holds. */
function matchesIn(text: string, cwd: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const word = /^\s*([^\s:]+)/.exec(line)?.[1]
    const path = word === undefined ? undefined : placeOf(cwd, word, home)?.path
    if (path !== undefined && known.has(path)) out.add(path)
    if (out.size >= MAX_MATCHES) break
  }
  return [...out]
}

/** Bytes of a copy or write landed so far, also into a folder or rsync's `.name.XXXXXX` temp file. */
async function landed($: EngineInterface, file: string, sources: readonly Located[]): Promise<number | undefined> {
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (stat?.kind === 'file') return stat.size
  const source = sources[0]?.file
  if (stat?.kind === 'dir') return sources.length === 1 && source !== undefined ? landed($, `${file}/${baseName(source)}`, []) : undefined
  const temp = (await $.fs.list(file.slice(0, file.lastIndexOf('/')) || '/').catch(() => [])).find(x => x.name.startsWith(`.${baseName(file)}.`))
  return temp?.size
}

/** While a shell command writes one local file, keeps its activity's byte count, and the sources' total, current. */
function watchProgress($: EngineInterface, targets: readonly Located[]): () => void {
  const written = targets.filter(t => (t.op === 'create' || t.op === 'edit') && t.file !== undefined)
  const dest = written[0]
  if (written.length !== 1 || dest?.file === undefined) return () => undefined
  const file = dest.file
  const sources = targets.filter(t => t.op === 'view' && t.file !== undefined)
  let total: number | undefined
  void Promise.all(sources.map(s => $.fs.stat(s.file ?? '').then(x => (x.kind === 'file' ? x.size : 0), () => 0))).then(sizes => {
    total = sizes.reduce((sum, n) => sum + n, 0) || undefined
  })
  const timer = $.clock.every(PROGRESS_MS, () => {
    void landed($, file, sources).then(bytes =>
      update($, activity, map => {
        const a = map[dest.path]
        if (bytes === undefined || a === undefined || a.running === 0 || (a.bytes === bytes && a.total === total)) return map
        return { ...map, [dest.path]: { ...a, bytes, total } }
      }),
    )
  })
  return () => timer.cancel()
}

/** The file's text before an edit: empty for a new file, undefined when it can't be replayed. */
async function textBefore($: EngineInterface, path: string, target: Target): Promise<string | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return target.op === 'create' ? '' : undefined
  if (stat.kind !== 'file' || stat.size > MAX_BYTES) return undefined
  return $.fs.read(path).catch(() => undefined)
}

/** The files whose change the code view replays: an editor's, or those a shell command writes or names. */
async function replaysOf($: EngineInterface, tool: string, input: Record<string, unknown>, targets: readonly Located[], cwd: string): Promise<Located[]> {
  if (!EDITORS.has(tool) && tool !== 'Bash') return []
  const written = targets.filter(t => (t.op === 'edit' || t.op === 'create') && t.file !== undefined)
  const command = tool === 'Bash' && typeof input['command'] === 'string' ? input['command'] : ''
  const named = mentionsOf(command)
    .map(w => placeOf(cwd, w, home))
    .filter((p): p is { file: string; path: string } => p !== undefined && !written.some(t => t.file === p.file))
    .map((p): Located => ({ op: 'view', ...p }))
  return [...written, ...named].slice(0, MAX_REPLAYS)
}

function setStatus($: EngineInterface, text: string | undefined) {
  if (text !== undefined && !isWatching) return
  try {
    $.ui.status(text)
  } catch {
    // A surface with no status line.
  }
}

function startAnimating(now: number) {
  animateUntil = Math.max(animateUntil, now + T.trail + 2000)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = await $.env.get('HOME').catch(() => undefined)
    await $.command.register({
      name: 'watch',
      description: 'Toggle Claude Work Visualized: the live map of where Claude is working',
    }).catch(() => undefined)
    await $.command.register({
      name: 'prs',
      description: 'Toggle pull requests in the work pane\'s git graph',
    }).catch(() => undefined)
    prs = (await $.store.get('prs').catch(() => undefined)) === 'hidden' ? 'hidden' : 'shown'
    await $.command.register({
      name: 'diffs',
      description: 'Toggle full edit diffs in the chat while the work pane replays them',
    }).catch(() => undefined)
    chatDiffs = (await $.store.get('chatDiffs').catch(() => undefined)) === 'full' ? 'full' : 'quiet'
    const now = await $.clock.now()
    const stored = await $.store.get('watching').catch(() => undefined)
    const isOn = stored !== false
    await update($, watching, () => isOn)
    isWatching = isOn
    startAnimating(now)
    void rescan($, new Set(), 'poll')
    if (isOn) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    // The frame clock: redraws while anything moves, and tidies spent state.
    let lastTidy = 0
    $.clock.every(FRAME_MS, () => {
      void (async () => {
        if (!(await read($, watching))) return
        const t = await $.clock.now()
        if (t < animateUntil) $.ui.invalidate('ui.render')
        if (t - lastTidy < 1000) return
        lastTidy = t
        const g = await read($, ghosts)
        if (Object.values(g).some(x => t - x.at >= T.ghostGone + 200)) {
          await update($, ghosts, map => Object.fromEntries(Object.entries(map).filter(([, x]) => t - x.at < T.ghostGone + 200)))
        }
        const a = await read($, activity)
        const stale = staleKeys(a, t)
        if (stale.length > 0) {
          await update($, activity, map => {
            const out = { ...map }
            for (const p of stale) delete out[p]
            return out
          })
        }
        const c = await read($, clips)
        const isKept = (x: Clip) => !isClipDone(x, t) || isBrowsed(x, t)
        if (c.some(x => !isKept(x))) await update($, clips, list => list.filter(isKept))
        const isGitShown = gitFade(await read($, git), t) < 1
        // A long run keeps drawing; once nothing moves the clock winds down.
        if (isAnimating(a, g, await read($, turn), t, await read($, thought)) || isGitShown) startAnimating(t)
        else if (t > animateUntil - T.trail) animateUntil = Math.min(animateUntil, t + 1500)
      })()
    })

    // Live sync with the disk: files changed by anything (a script, a build,
    // another editor) show up without waiting for a tool call to end.
    let polling = false
    $.clock.every(POLL_MS, () => {
      if (polling) return
      polling = true
      void (async () => {
        if (!(await read($, watching))) return
        await rescan($, new Set(), 'poll')
        // A long command (a script that commits, a slow push) shows its commits as they land.
        const gs = await read($, git)
        if (gs === null || gs.endedAt !== undefined) return
        const fresh = await readGit($, gs.dir, gs.refs)
        if (fresh !== undefined) await update($, git, s => (s === null || s.endedAt !== undefined || s.dir !== gs.dir ? s : gitRead(s, fresh)))
      })().finally(() => {
        polling = false
      })
    })

    return next(e)
  })

  on('command.run', { command: 'diffs' }, async $ => {
    chatDiffs = chatDiffs === 'quiet' ? 'full' : 'quiet'
    await $.store.set('chatDiffs', chatDiffs).catch(() => undefined)
    return {
      text: chatDiffs === 'full'
        ? 'Edits show their full diff in the chat. /diffs makes them one line again.'
        : 'Edits show as one line in the chat while the work pane replays them.',
    }
  })

  // The pane replays each edit, so while it shows, the chat keeps one line per edit.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (chatDiffs === 'full' || !EDITORS.has(e.props.tool) || e.props.isErrored) return next(e)
    const stats = patchStats(e.props.output)
    const isPaneShown = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE && p.isShown && p.isPlaced)
    if (stats === undefined || !isPaneShown) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const file = (e.props.output as { filePath?: unknown }).filePath
    const cwd = await $.session.cwd()
    const path = typeof file === 'string' ? placeOf(cwd, file, home)?.path ?? file : 'file'
    const isNew = (e.props.output as { type?: unknown }).type === 'create'
    return (
      <Box flexDirection="row">
        <Text color={isNew ? COLOR.create : COLOR.edit}>{isNew ? `${ICON.create} Created ` : `${ICON.edit} Edited `}</Text>
        <Text bold>{path}</Text>
        <Text color={COLOR.create}>{` +${stats.adds}`}</Text>
        <Text color={COLOR.delete}>{` -${stats.dels}`}</Text>
        <Text color={MUTED}> · in the work pane</Text>
      </Box>
    )
  })

  on('command.run', { command: 'prs' }, async $ => {
    prs = prs === 'shown' ? 'hidden' : 'shown'
    await $.store.set('prs', prs).catch(() => undefined)
    $.ui.invalidate('ui.render')
    return { text: prs === 'shown' ? 'Pull requests show in the git graph.' : 'Pull requests are hidden from the git graph. /prs shows them again.' }
  })

  on('command.run', { command: 'watch' }, async $ => {
    const isOn = !(await read($, watching))
    await update($, watching, () => isOn)
    isWatching = isOn
    await $.store.set('watching', isOn).catch(() => undefined)
    if (!isOn) {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      setStatus($, undefined)
      return { text: 'Claude Work Visualized is off. /watch turns it back on.' }
    }
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    startAnimating(await $.clock.now())
    void rescan($, new Set(), 'poll')
    return { text: 'Claude Work Visualized is on: watching the project live.' }
  })

  // Closing the pane by hand switches watching off too, so /watch reopens it.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, watching, () => false)
      isWatching = false
      await $.store.set('watching', false).catch(() => undefined)
      setStatus($, undefined)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turn, () => ({ ...emptyTurn(), phase: 'working' as const, at: now }))
    startAnimating(now)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, turn, info => ({ ...info, phase: 'complete' as const, at: now, doing: undefined }))
      startAnimating(now)
      setStatus($, undefined)
    }
    return next(e)
  })

  // Thinking streams in pieces; the pane types each thought out as it arrives.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !isWatching) return yield* next(e)
    const begun = await $.clock.now()
    await update($, thought, t => ({ ...(t ?? { key: '', text: '', dropped: 0, at: begun, endedAt: begun }), waitingSince: begun }))
    startAnimating(begun)
    const stream = next(e)
    let isOpen = false
    let isSettled = false
    // The response has moved past thinking: stop waiting, and end the thought if this step had one.
    const settle = async () => {
      if (isSettled) return
      isSettled = true
      const now = await $.clock.now()
      await update($, thought, t => {
        if (t === null) return t
        const { waitingSince: _, ...rest } = t
        return isOpen && rest.endedAt === undefined ? { ...rest, endedAt: now } : rest
      })
    }
    try {
      for (let step = await stream.next(); ; step = await stream.next()) {
        if (step.done === true) return step.value
        const chunk = step.value
        if (chunk.kind === 'thinking' && !isSettled) {
          const key = `${e.turnId}:${e.index}:${chunk.index}`
          isOpen = true
          const now = await $.clock.now()
          await update($, thought, t => {
            const fresh = withThought(t, key, chunk.text, now)
            return fresh.text === '' && t?.waitingSince !== undefined ? { ...fresh, waitingSince: t.waitingSince } : fresh
          })
          startAnimating(now)
        } else if (chunk.kind !== 'engine' && chunk.kind !== 'thinking') {
          await settle()
        }
        yield chunk
      }
    } finally {
      await settle()
    }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const mutates = tool === 'Bash' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit'
    const cwd = await $.session.cwd()
    const targets = await targetsOf($, tool, input, cwd).catch(() => [] as Located[])

    const startedAt = await $.clock.now()
    startAnimating(startedAt)
    // Work that names no file still shows on the prompt line while it runs.
    const doing = targets.length === 0 ? { text: doingOf(tool, input), at: startedAt } : undefined
    if (doing !== undefined) await update($, turn, info => ({ ...info, doing }))
    // A new file appears the moment Claude starts creating it; a file the
    // last scan missed joins the tree as Claude reaches it.
    const known = new Set((await read($, tree)).map(t => t.p))
    const added = targets.filter(t => !known.has(t.path))
    if (added.length > 0) {
      const isDir = (t: Target) => tool === 'Bash' && /\bmkdir\b/.test(String((e as { command?: unknown }).command ?? '')) && t.op === 'create'
      await update($, tree, list => added.reduce((acc, t) => withPath(acc, t.path, isDir(t)), list))
    }
    if (targets.length > 0) {
      await update($, activity, map => {
        const out = { ...map }
        for (const t of targets) out[t.path] = { op: t.op, startedAt, running: (map[t.path]?.running ?? 0) + 1 }
        return out
      })
      const first = targets[targets.length - 1]
      if (first) setStatus($, `${ICON[first.op]} ${LABEL[first.op]} ${first.path}`)
    }

    const replays = await replaysOf($, tool, input, targets, cwd)
    const befores = await Promise.all(replays.map(t => textBefore($, t.file ?? '', t)))

    const stopProgress = tool === 'Bash' ? watchProgress($, targets) : () => undefined
    if (mutates) changingCalls++
    const ran = await next(e).finally(() => {
      if (mutates) changingCalls--
      stopProgress()
    })
    // A failing shell chain may still have changed files before the step that failed.
    const failed = ran.deny !== undefined || (ran.isError === true && tool !== 'Bash')

    const endedAt = await $.clock.now()
    startAnimating(endedAt)
    if (doing !== undefined) {
      await update($, turn, info => (info.doing?.at === doing.at && info.doing.text === doing.text ? { ...info, doing: undefined } : info))
    }
    // The files a search or listing turned up flash as read.
    const matched = failed || !OUTPUT_LISTERS.has(tool) || ran.text === undefined ? [] : matchesIn(ran.text, cwd, known).filter(p => !targets.some(t => t.path === p))
    if (matched.length > 0) {
      await update($, activity, map => ({
        ...map,
        ...Object.fromEntries(matched.filter(p => !map[p]?.running).map(p => [p, { op: 'view' as const, startedAt: endedAt, endedAt, running: 0 }])),
      }))
      await update($, turn, info => matched.reduce((acc, p) => counted(acc, 'view', p), info))
    }
    if (targets.length > 0) {
      await update($, activity, map => {
        const out = { ...map }
        for (const t of targets) {
          const a = out[t.path]
          if (a === undefined) continue
          const running = Math.max(0, a.running - 1)
          out[t.path] = running > 0 ? { ...a, running } : { ...a, running: 0, endedAt }
          if (failed && t.op !== 'view' && running === 0) delete out[t.path]
        }
        return out
      })
      if (!failed) {
        await update($, turn, info => targets.reduce((acc, t) => (t.op === 'delete' && !isUnscanned(t.path) ? acc : counted(acc, t.op, t.path)), info))
      }
      // No rescan sees a remote delete, so it turns into a ghost here.
      const remoteGone = failed ? [] : targets.filter(t => t.op === 'delete' && isUnscanned(t.path))
      if (remoteGone.length > 0) {
        await update($, ghosts, map => ({ ...map, ...Object.fromEntries(remoteGone.map(t => [t.path, { d: false, at: endedAt }])) }))
        await update($, activity, map => Object.fromEntries(Object.entries(map).filter(([p]) => !remoteGone.some(t => t.path === p))))
        await update($, tree, list => remoteGone.reduce((acc, t) => withoutPath(acc, t.path), list))
      }
      const left = await read($, activity)
      if (focusOf(left) === undefined) setStatus($, undefined)
    }
    for (const [i, t] of replays.entries()) {
      const before = befores[i]
      if (failed || before === undefined) continue
      // Read back from disk, so a formatter's changes show as well.
      const after = await $.fs.read(t.file ?? '').catch(() => undefined)
      const clip = after === undefined ? undefined : clipOf(t.path, before, after, endedAt)
      if (clip === undefined) continue
      await update($, clips, list => enqueue(list, clip, endedAt))
      // A file the command only named, changed after all: an edit, so the tree shows it too.
      if (targets.some(x => x.path === t.path)) continue
      await update($, tree, list => withPath(list, t.path, false))
      await update($, activity, map => ({ ...map, [t.path]: { op: 'edit' as const, startedAt, endedAt, running: 0 } }))
      await update($, turn, info => counted(info, 'edit', t.path))
    }
    if (mutates) {
      // Deletes become ghosts through the rescan, so they play their exit.
      const claimed = new Set(targets.filter(t => t.op !== 'delete').map(t => t.path))
      if (failed) {
        await update($, tree, list => added.reduce((acc, t) => withoutPath(acc, t.path), list))
      }
      void rescan($, claimed, 'tool')
    }
    return ran
  })

  // Git and gh commands: the branch graph is read again after each, and the command animates on it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    const actions = gitActionsOf(command)
    const action = mainAction(actions)
    if (action === undefined || !isWatching) return next(e)
    const cwd = await $.session.cwd()
    // The repository the command ran in; a folder hidden in a variable can't be read.
    const dir = repoDir(action.dir, cwd, home)
    if (dir === undefined) return next(e)
    const known = await read($, git)
    if (known === null || known.dir !== dir) {
      const first = await readGit($, dir, [])
      if (first === undefined) return next(e)
      await update($, git, () => gitEnded(gitStarted(null, action, 0, dir), first, [], false, 0))
    }
    const startedAt = await $.clock.now()
    const before = await read($, git)
    await update($, git, s => gitStarted(s, action, startedAt, dir))
    startAnimating(startedAt)

    const ran = await next(e)
    const isFailed = ran.deny !== undefined || ran.isError === true
    const stdout = String((ran.result as { stdout?: unknown } | undefined)?.stdout ?? '')
    const refs = refsAfter(before?.refs ?? [], action, before?.head ?? '')
    const fresh = await readGit($, dir, refs)
    const now = await $.clock.now()
    await update($, git, s => {
      const ended = gitEnded(s ?? gitStarted(null, action, now, dir), fresh, refs, isFailed, now)
      return isFailed ? ended : withPr(ended, actions, command, stdout, now)
    })
    startAnimating(now)
    return ran
  })

  // The wheel, a touchpad or the scroll keys over the code view move through the edited file.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const th = await read($, thought)
    if (th !== null && thinkArea !== undefined && e.pointer !== undefined && isOverCode(e.pointer, thinkArea)) {
      const from = thinkBrowse?.key === th.key ? thinkBrowse.top : thinkTop
      thinkBrowse = { key: th.key, top: Math.max(0, from + e.by * WHEEL_LINES), at: await $.clock.now() }
      $.ui.invalidate('ui.render')
      return {}
    }
    const moved = browseAfter(browse, shownClip, codeArea, e, await $.clock.now())
    if (moved === undefined) return next(e)
    browse = moved
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const entries = await read($, tree)
    const act = await read($, activity)
    const gh = await read($, ghosts)
    const info = await read($, turn)
    const th = await read($, thought)
    const gs = await read($, git)
    if (th !== null) {
      if (th.key !== typed.key) typed = { key: th.key, n: th.dropped, at: now }
      const pace = th.endedAt === undefined ? 'reading' : 'late'
      typed = { key: th.key, n: typeTo(typed.n, th.dropped + th.text.length, Math.min(250, now - typed.at), pace), at: now }
    }
    // A scrolled thought stays put until a new one starts or the person leaves it a while.
    if (thinkBrowse !== undefined && (th === null || thinkBrowse.key !== th.key || now - thinkBrowse.at > HOLD)) thinkBrowse = undefined
    const sessionRoot = (await $.session.cwd()).replace(/\/+$/, '')
    const root = sessionRoot.split('/').pop() ?? ''
    const paneColumns = Math.max(24, (e.props.bodyColumns ?? 40) - 1)
    const height = Math.max(8, e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - 3)
    const list = await read($, clips)
    const latest = currentClip(list, now)
    // A file the person is scrolling stays until Claude's next edit, or until they leave it a while.
    const browsed = list.find(x => isBrowsed(x, now))
    if (browse !== undefined && (browsed === undefined || (latest !== undefined && clipKey(latest) !== browse.key))) browse = undefined
    const clip = browse !== undefined ? browsed : latest
    shownClip = clip

    const line = (segs: Seg[], key: string) => (
      <Box key={key} flexDirection="row" height={1}>
        {merge(segs).map(s => (
          <Text color={s.c} backgroundColor={s.bg} bold={s.b} dimColor={s.dim} strikethrough={s.s} wrap="truncate">
            {s.t}
          </Text>
        ))}
      </Box>
    )
    // `── label ─────`, a section rule; a plain rule when the label is empty.
    const rule = (label: string, key: string, columns: number, c = FAINT) =>
      line(
        label === ''
          ? [{ t: '─'.repeat(columns), c: FAINT }]
          : [{ t: '── ', c: FAINT }, { t: label, c, b: true }, { t: ' ' + '─'.repeat(Math.max(0, columns - label.length - 4)), c: FAINT }],
        key,
      )
    // The prompt line already says thinking while Claude thinks: the section then needs no title.
    const saysThinking = focusOf(act) === undefined && info.doing === undefined && gitDoingOf(gs) === undefined && info.phase === 'working'

    /** The thinking section at `at` in the pane: its rule (`always`, or only when it has something to say) and lines. */
    function thinkingSection(columns: number, rows: number, at: { column: number; row: number }, titled: 'always' | 'when-needed') {
      const think = thoughtView({ thought: th, typed: typed.n, now, turn: info, columns, rows, top: thinkBrowse?.top })
      thinkTop = think.top
      // Scrolled back down to the end: follow the typing again.
      if (thinkBrowse !== undefined && think.below === 0) thinkBrowse = undefined
      else if (thinkBrowse !== undefined) thinkBrowse = { ...thinkBrowse, top: think.top }
      const arrows = `${think.above > 0 ? ` ↑${think.above}` : ''}${think.below > 0 ? ` ↓${think.below}` : ''}`.trim()
      const label = saysThinking ? arrows : `thinking${think.waited !== undefined ? ` ${think.waited}s` : ''}${arrows === '' ? '' : ` ${arrows}`}`
      const hasRule = think.lines.length > 0 && (label !== '' || titled === 'always')
      const used = think.lines.length + (hasRule ? 1 : 0)
      thinkArea = used > 0 ? { column: at.column, row: at.row, columns, rows: used } : undefined
      const els = [
        hasRule && rule(label, 'r0', columns, mix(CLAUDE, FAINT, think.fade)),
        ...think.lines.map((segs, i) => line(segs, `th${i}`)),
      ]
      return { els, rows: used, waited: think.waited }
    }

    function gitSection(columns: number, rows: number) {
      const gv = gitView(gs, now, columns, rows, sessionRoot, prs)
      const used = gv.lines.length > 0 ? gv.lines.length + 1 : 0
      const els = used === 0 ? [] : [rule(gv.label, 'rg', columns, mix(CLAUDE, FAINT, gv.fade)), ...gv.lines.map((segs, i) => line(segs, `git${i}`))]
      return { els, rows: used }
    }

    /** The code view's rule and rows, replaying the edit or showing where the person scrolled. */
    function codeSection(columns: number, rows: number) {
      if (clip === undefined) return undefined
      let view: { from: number; to: number } | undefined
      let segs: Seg[][]
      if (browse !== undefined) {
        const shown = fileLines(clip, columns, rows, browse.top)
        browse = { ...browse, top: shown.top }
        view = { from: shown.from, to: shown.to }
        segs = shown.lines
      } else {
        const replay = codeLines(clip, now, columns, rows, codeScroll)
        codeScroll = replay.scroll
        segs = replay.lines
      }
      return (
        <Box flexDirection="column" width={columns}>
          {line(codeRule(clip, columns, view), 'cr')}
          {segs.map((row, i) => line(row, `c${i}`))}
        </Box>
      )
    }

    // From SPLIT_COLUMNS wide, what Claude is doing (thinking, git, the code view) goes beside the tree.
    const hasThinking = thoughtView({ thought: th, typed: typed.n, now, turn: info, columns: 40, rows: 1 }).lines.length > 0
    const hasGit = gitView(gs, now, 40, 1, sessionRoot, prs).lines.length > 0
    const isSplit = paneColumns >= SPLIT_COLUMNS && (clip !== undefined || hasThinking || hasGit)
    if (isSplit) {
      const treeColumns = Math.max(30, Math.min(48, Math.floor(paneColumns * 0.4)))
      const sideColumns = paneColumns - treeColumns - 2
      // With an edit to show, thinking and git leave the code view most of the column.
      const share = clip === undefined ? 0.45 : 0.25
      const thinking = thinkingSection(sideColumns, Math.max(3, Math.floor(height * share)), { column: treeColumns + 2, row: 0 }, 'always')
      const gitPart = gitSection(sideColumns, Math.max(4, Math.floor(height * share)))
      const codeRows = Math.max(3, height - 1 - thinking.rows - gitPart.rows)
      codeArea = clip === undefined ? undefined : { column: treeColumns + 2, row: thinking.rows + gitPart.rows, columns: sideColumns, rows: codeRows + 1 }
      return (
        <Box flexDirection="row" width={paneColumns} flexGrow={1}>
          {mapView(treeColumns, saysThinking ? thinking.waited : undefined)}
          <Box width={2} />
          <Box flexDirection="column" width={sideColumns}>
            {thinking.els}
            {gitPart.els}
            {codeSection(sideColumns, codeRows)}
          </Box>
        </Box>
      )
    }

    const thinking = thinkingSection(paneColumns, thoughtRows(height), { column: 0, row: 2 }, 'when-needed')
    const gitPart = gitSection(paneColumns, gitRows(height))
    const codeRows = clip === undefined ? 0 : Math.max(3, Math.min(Math.max(clip.before.length, clip.after.length) + 2, Math.floor(height * 0.45)))
    codeArea = clip === undefined ? undefined : { column: 0, row: 0, columns: paneColumns, rows: codeRows + 1 }
    const above = { els: [...thinking.els, ...gitPart.els], rows: thinking.rows + gitPart.rows }
    return mapView(paneColumns, saysThinking ? thinking.waited : undefined, above, codeSection(paneColumns, codeRows), clip === undefined ? 0 : codeRows + 1)

    /** The tree with its header, status, summary card and legend; `over` goes above the tree, `under` below it. */
    function mapView(columns: number, waited?: number, over = { els: [] as RenderChildren[], rows: 0 }, under?: RenderChildren, underRows = 0) {
      const rows = buildRows({ tree: entries, activity: act, ghosts: gh, now, columns, folders })
      const summary = summaryLines(info, now, columns - 4)
      const legend = legendLines(columns)
      const chrome = 3 + 1 + legend.length + 1 + (summary.length > 0 ? summary.length + 2 : 0) + over.rows + underRows
      const room = Math.max(3, height - chrome)
      const focus = focusOf(act)
      scroll = scrollTo(scroll, rows, focus, room)
      const visible = rows.slice(scroll, scroll + room)
      const above = scroll
      const below = Math.max(0, rows.length - scroll - room)
      const fileCount = entries.filter(t => !t.d).length
      // Under the tree, the code view starts below the header, the tree and the card.
      if (under !== undefined && codeArea !== undefined) {
        codeArea = { ...codeArea, row: 3 + over.rows + visible.length + (below > 0 ? 1 : 0) + (summary.length > 0 ? summary.length + 2 : 0) }
      }
      const age = now - info.at
      const card = Math.min(smoothIn(age / 500), info.phase === 'complete' && age > T.summary - 1500 ? Math.max(0, (T.summary - age) / 1500) : 1)

      return (
        <Box flexDirection="column" width={columns} flexGrow={1}>
          {line(headerLine(now, focus !== undefined || info.phase === 'working', root, remoteOf(act, now)), 'h')}
          {line(statusLine(act, info, now, fileCount, columns, { waited, git: gitDoingOf(gs) }), 's')}
          {over.els}
          {rule(above > 0 ? `tree ↑${above}` : 'tree', 'r1', columns)}
          {rows.length === 0 ? line([{ t: ' scanning…', c: MUTED }], 'empty') : visible.map(r => line(r.segs, r.key))}
          {below > 0 && line([{ t: `   ↓ ${below} more`, c: FAINT }], 'down')}
          {summary.length > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor={mix(FAINT, COLOR.create, card * 0.8)} paddingX={1}>
              {summary.map((segs, i) => line(segs, `sum${i}`))}
            </Box>
          )}
          {under}
          <Box flexGrow={1} />
          {rule('legend', 'r2', columns)}
          {legend.map((segs, i) => line(segs, `leg${i}`))}
        </Box>
      )
    }
  })
}

/** Whether the person is still scrolling through this clip's file. */
const isBrowsed = (clip: Clip, now: number) => browse !== undefined && browse.key === clipKey(clip) && now - browse.at < HOLD

const smoothIn = (t: number) => {
  const k = Math.min(1, Math.max(0, t))
  return k * k * (3 - 2 * k)
}

/** Joins neighbouring cells of one style, so a painted row stays a few Texts. */
function merge(segs: readonly Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (s.t === '') continue
    const last = out[out.length - 1]
    if (last && last.c === s.c && last.bg === s.bg && !!last.b === !!s.b && !!last.dim === !!s.dim && !!last.s === !!s.s) {
      out[out.length - 1] = { ...last, t: last.t + s.t }
    } else out.push(s)
  }
  return out
}

/** Rows the git view gets: a share of the pane's height, within limits. */
const gitRows = (height: number) => Math.max(4, Math.min(12, Math.floor(height * 0.3)))

/** Reads the branch graph and how far HEAD is from its upstream; undefined outside a repository. */
async function readGit($: EngineInterface, cwd: string, refs: readonly string[]): Promise<GitRead | undefined> {
  const run = (argv: readonly string[]) => $.process.run(argv, { cwd, timeoutMs: 5000 }).catch(() => undefined)
  let log = await run(graphArgv(refs))
  // A branch named earlier may be gone: draw HEAD alone then.
  if (log?.exitCode !== 0 && refs.length > 0) log = await run(graphArgv([]))
  if (log === undefined || log.exitCode !== 0) return undefined
  const counts = await run(AHEAD_ARGV)
  const [ahead, behind] = counts?.exitCode === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : []
  return { rows: parseGraph(log.stdout), ahead, behind }
}

/** Opens or merges the PR card when a `gh pr` command printed a PR's URL. */
function withPr(state: GitState, actions: readonly GitAction[], command: string, stdout: string, now: number): GitState {
  const n = prNumberOf(stdout)
  if (actions.some(a => a.kind === 'pr') && n !== undefined) {
    const base = prBaseOf(command)
    return { ...state, pr: { number: n, head: state.head, ...(base === undefined ? {} : { base }), state: 'open', at: now } }
  }
  const merged = actions.find(a => a.kind === 'pr-merge')
  if (merged === undefined) return state
  const number = merged.ref !== undefined ? Number(merged.ref) : n ?? state.pr?.number
  if (number === undefined) return state
  const head = state.pr?.number === number ? state.pr.head : state.head
  return { ...state, pr: { number, head, ...(state.pr?.base === undefined ? {} : { base: state.pr.base }), state: 'merged', at: now } }
}
