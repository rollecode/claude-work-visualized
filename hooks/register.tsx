import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, Clip, Ghost, Op, TreeEntry, TurnInfo } from '../types'
import { MAX_BYTES, clipOf, codeLines, codeRule, currentClip, enqueue, isClipDone } from './code'
import {
  COLOR, FAINT, ICON, IGNORED, LABEL, MUTED, T,
  buildRows, classifyBash, counted, diffTrees, emptyTurn, focusOf, headerLine, isAnimating, legendLines, mix,
  relPath, scrollTo, staleKeys, statusLine, summaryLines, withPath, withoutPath,
} from './model'
import type { FolderMemory, Seg, Target } from './model'

const PANE = 'work-map'
const TITLE = 'Claude Work'
const MAX_ENTRIES = 2000
const MAX_DEPTH = 12
const FRAME_MS = 33 // ~30 fps while anything moves, the terminal's cap for a shown pane
const POLL_MS = 1500 // how often the project is rescanned for changes made outside tool calls
const SPLIT_COLUMNS = 96 // from this wide the code view sits beside the tree, else under it
const EDITORS = new Set(['Edit', 'MultiEdit', 'Write'])

const tree = atom({ plugin: 'work-visualized', key: 'tree' } as const, [] as TreeEntry[])
const activity = atom({ plugin: 'work-visualized', key: 'activity' } as const, {} as Record<string, Activity>)
const ghosts = atom({ plugin: 'work-visualized', key: 'ghosts' } as const, {} as Record<string, Ghost>)
const turn = atom({ plugin: 'work-visualized', key: 'turn' } as const, emptyTurn())
const watching = atom({ plugin: 'work-visualized', key: 'watching' } as const, true)
const clips = atom({ plugin: 'work-visualized', key: 'clips' } as const, [] as Clip[])

// Drawing memory only: a reload starts these over, harmlessly.
const folders: FolderMemory = new Map()
let scroll = 0
let codeScroll = 0
let animateUntil = 0
let isWatching = true // mirrors the watching atom for synchronous checks
let scanning: Promise<unknown> = Promise.resolve()

async function scanTree($: EngineInterface): Promise<TreeEntry[]> {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const out: TreeEntry[] = []
  let level: string[] = ['']
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && out.length < MAX_ENTRIES; depth++) {
    const next: string[] = []
    const lists = await Promise.all(level.map(dir => $.fs.list(dir === '' ? cwd : `${cwd}/${dir}`).catch(() => [])))
    level.forEach((dir, i) => {
      for (const entry of lists[i] ?? []) {
        if (IGNORED.has(entry.name) || out.length >= MAX_ENTRIES) continue
        const p = dir === '' ? entry.name : `${dir}/${entry.name}`
        const d = entry.kind === 'dir'
        out.push({ p, d, m: entry.mtimeMs })
        if (d) next.push(p)
      }
    })
    level = next
  }
  return out
}

/** Rescans the project and animates whatever changed that no tool call named. */
function rescan($: EngineInterface, claimed: ReadonlySet<string>): Promise<unknown> {
  scanning = scanning.then(async () => {
    const fresh = await scanTree($)
    const before = await read($, tree)
    const now = await $.clock.now()
    const diff = diffTrees(before, fresh)
    // Keep entries a running create put in early, so they don't blink out.
    const running = await read($, activity)
    const busy = new Set([...claimed, ...Object.keys(running).filter(p => (running[p]?.running ?? 0) > 0)])
    let merged = fresh
    for (const [p, a] of Object.entries(running)) {
      if (a.running > 0 && a.op === 'create') merged = withPath(merged, p, false)
    }
    await update($, tree, () => merged)
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
    await update($, turn, info => {
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

/** The paths a tool call touches, and how, relative to the session's folder. */
async function targetsOf($: EngineInterface, tool: string, input: Record<string, unknown>, cwd: string): Promise<Target[]> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if ((await read($, tree)).length === 0) await scanning
  const known = new Map((await read($, tree)).map(t => [t.p, t]))
  const resolve = (raw: string | undefined, op: Op): Target[] => {
    if (raw === undefined) return []
    const path = relPath(cwd, raw.startsWith('/') || raw.startsWith('~') ? raw : `${cwd}/${raw}`)
    if (path === undefined) return []
    // A shell word that names no known path is most likely not a path.
    if (tool === 'Bash' && op !== 'create' && !known.has(path)) return []
    return [{ op, path }]
  }
  switch (tool) {
    case 'Read':
      return resolve(str('file_path'), 'view')
    case 'Edit':
    case 'MultiEdit':
      return resolve(str('file_path'), 'edit')
    case 'NotebookEdit':
      return resolve(str('notebook_path'), 'edit')
    case 'Write': {
      const raw = str('file_path')
      const path = raw === undefined ? undefined : relPath(cwd, raw)
      return resolve(raw, path !== undefined && known.has(path) ? 'edit' : 'create')
    }
    case 'Glob':
    case 'Grep':
    case 'LS':
      return resolve(str('path') ?? cwd + '/.', 'view')
    case 'Bash': {
      const command = str('command') ?? ''
      return classifyBash(command).flatMap(t => {
        // Writing to a file that isn't there yet is a create.
        const path = relPath(cwd, t.path.startsWith('/') ? t.path : `${cwd}/${t.path}`)
        const op: Op = t.op === 'edit' && path !== undefined && !known.has(path) ? 'create' : t.op
        return resolve(t.path, op)
      })
    }
    default:
      return []
  }
}

/** The file's text before an edit: empty for a new file, undefined when it can't be replayed. */
async function textBefore($: EngineInterface, path: string, target: Target): Promise<string | undefined> {
  if (target.op === 'create') return ''
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.size > MAX_BYTES) return undefined
  return $.fs.read(path).catch(() => undefined)
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
    await $.command.register({
      name: 'watch',
      description: 'Toggle Claude Work Visualized: the live map of where Claude is working',
    }).catch(() => undefined)
    const now = await $.clock.now()
    const stored = await $.store.get('watching').catch(() => undefined)
    const isOn = stored !== false
    await update($, watching, () => isOn)
    isWatching = isOn
    startAnimating(now)
    void rescan($, new Set())
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
        if (c.some(x => isClipDone(x, t))) await update($, clips, list => list.filter(x => !isClipDone(x, t)))
        if (!isAnimating(a, g, await read($, turn), t) && t > animateUntil - T.trail) animateUntil = Math.min(animateUntil, t + 1500)
      })()
    })

    // Live sync with the disk: files changed by anything (a script, a build,
    // another editor) show up without waiting for a tool call to end.
    let polling = false
    $.clock.every(POLL_MS, () => {
      if (polling) return
      polling = true
      void (async () => {
        if (await read($, watching)) await rescan($, new Set())
      })().finally(() => {
        polling = false
      })
    })

    return next(e)
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
    void rescan($, new Set())
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
      await update($, turn, info => ({ ...info, phase: 'complete' as const, at: now }))
      startAnimating(now)
      setStatus($, undefined)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const mutates = tool === 'Bash' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit'
    const cwd = await $.session.cwd()
    const targets = await targetsOf($, tool, e as unknown as Record<string, unknown>, cwd).catch(() => [] as Target[])
    if (targets.length === 0 && !mutates) return next(e)

    const startedAt = await $.clock.now()
    startAnimating(startedAt)
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

    const filePath = (e as { file_path?: unknown }).file_path
    const edited = EDITORS.has(tool) && typeof filePath === 'string' ? targets[0] : undefined
    const before = edited === undefined ? undefined : await textBefore($, filePath as string, edited)

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true

    const endedAt = await $.clock.now()
    startAnimating(endedAt)
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
        await update($, turn, info => targets.reduce((acc, t) => (t.op === 'delete' ? acc : counted(acc, t.op, t.path)), info))
      }
      const left = await read($, activity)
      if (focusOf(left) === undefined) setStatus($, undefined)
    }
    if (!failed && edited !== undefined && before !== undefined) {
      // Read back from disk, so a formatter's changes show as well.
      const after = await $.fs.read(filePath as string).catch(() => undefined)
      const clip = after === undefined ? undefined : clipOf(edited.path, before, after, endedAt)
      if (clip !== undefined) await update($, clips, list => enqueue(list, clip, endedAt))
    }
    if (mutates) {
      // Deletes become ghosts through the rescan, so they play their exit.
      const claimed = new Set(targets.filter(t => t.op !== 'delete').map(t => t.path))
      if (failed) {
        await update($, tree, list => added.reduce((acc, t) => withoutPath(acc, t.path), list))
      }
      void rescan($, claimed)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const entries = await read($, tree)
    const act = await read($, activity)
    const gh = await read($, ghosts)
    const info = await read($, turn)
    const root = (await $.session.cwd()).replace(/\/+$/, '').split('/').pop() ?? ''
    const paneColumns = Math.max(24, (e.props.bodyColumns ?? 40) - 1)
    const height = Math.max(8, e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - 3)
    const clip = currentClip(await read($, clips), now)

    const line = (segs: Seg[], key: string) => (
      <Box key={key} flexDirection="row" height={1}>
        {merge(segs).map(s => (
          <Text color={s.c} backgroundColor={s.bg} bold={s.b} dimColor={s.dim} strikethrough={s.s} wrap="truncate">
            {s.t}
          </Text>
        ))}
      </Box>
    )
    const isSplit = clip !== undefined && paneColumns >= SPLIT_COLUMNS
    const treeColumns = isSplit ? Math.max(30, Math.min(48, Math.floor(paneColumns * 0.4))) : paneColumns
    const codeColumns = isSplit ? paneColumns - treeColumns - 2 : paneColumns
    const codeRows = clip === undefined
      ? 0
      : isSplit
        ? height - 1
        : Math.max(3, Math.min(Math.max(clip.before.length, clip.after.length) + 2, Math.floor(height * 0.45)))
    const codeView = clip === undefined ? { lines: [], scroll: 0 } : codeLines(clip, now, codeColumns, codeRows, codeScroll)
    codeScroll = codeView.scroll
    const code = clip !== undefined && (
      <Box flexDirection="column" width={codeColumns}>
        {line(codeRule(clip, codeColumns), 'cr')}
        {codeView.lines.map((segs, i) => line(segs, `c${i}`))}
      </Box>
    )

    if (isSplit) {
      return (
        <Box flexDirection="row" width={paneColumns}>
          {mapView(treeColumns)}
          <Box width={2} />
          {code}
        </Box>
      )
    }
    return mapView(paneColumns, code, clip === undefined ? 0 : codeRows + 1)

    /** The tree with its header, status, summary card and legend; `under` goes below the tree. */
    function mapView(columns: number, under?: RenderChildren, underRows = 0) {
      // `── label ─────`, a section rule.
      const rule = (label: string, key: string, c = FAINT) =>
        line([{ t: '── ', c: FAINT }, { t: label, c, b: true }, { t: ' ' + '─'.repeat(Math.max(0, columns - label.length - 4)), c: FAINT }], key)

      const rows = buildRows({ tree: entries, activity: act, ghosts: gh, now, columns, folders })
      const summary = summaryLines(info, now, columns - 4)
      const legend = legendLines(columns)
      const chrome = 3 + 1 + legend.length + 1 + (summary.length > 0 ? summary.length + 2 : 0) + underRows
      const room = Math.max(3, height - chrome)
      const focus = focusOf(act)
      scroll = scrollTo(scroll, rows, focus, room)
      const visible = rows.slice(scroll, scroll + room)
      const above = scroll
      const below = Math.max(0, rows.length - scroll - room)
      const fileCount = entries.filter(t => !t.d).length
      const age = now - info.at
      const card = Math.min(smoothIn(age / 500), info.phase === 'complete' && age > T.summary - 1500 ? Math.max(0, (T.summary - age) / 1500) : 1)

      return (
        <Box flexDirection="column" width={columns}>
          {line(headerLine(now, focus !== undefined || info.phase === 'working', root), 'h')}
          {line(statusLine(act, info, now, fileCount, columns), 's')}
          {rule(above > 0 ? `tree ↑${above}` : 'tree', 'r1')}
          {rows.length === 0 ? line([{ t: ' scanning…', c: MUTED }], 'empty') : visible.map(r => line(r.segs, r.key))}
          {below > 0 && line([{ t: `   ↓ ${below} more`, c: FAINT }], 'down')}
          {summary.length > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor={mix(FAINT, COLOR.create, card * 0.8)} paddingX={1}>
              {summary.map((segs, i) => line(segs, `sum${i}`))}
            </Box>
          )}
          {under}
          <Box flexGrow={1} />
          {rule('legend', 'r2')}
          {legend.map((segs, i) => line(segs, `leg${i}`))}
        </Box>
      )
    }
  })
}

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
