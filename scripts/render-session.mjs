// Renders docs/media/session.gif: Claude Code with the work pane beside it.
//
// The chat column is a mockup of Claude Code with verbose output off and the
// edits kept to one line. The pane is drawn by the plugin's own code
// (hooks/model.ts and hooks/code.ts), replaying real edits to a small project.
//
//   node scripts/render-session.mjs          # needs Node 23.6+, Playwright, ffmpeg
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright PLAYWRIGHT_CHANNEL=chrome node scripts/render-session.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The hooks import each other without extensions, as the plugin engine allows.
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx)
    } catch (err) {
      if (!spec.startsWith('.')) throw err
      for (const ext of ['.ts', '.js']) {
        try {
          return next(spec + ext, ctx)
        } catch {}
      }
      throw err
    }
  },
})

const { clipOf, codeLines, codeRule, currentClip } = await import('../hooks/code.ts')
const {
  CLAUDE, COLOR, FAINT, ICON, MUTED,
  buildRows, counted, emptyTurn, focusOf, headerLine, legendLines, mix, scrollTo, statusLine, summaryLines,
} = await import('../hooks/model.ts')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'media')
const FRAMES = join(OUT, '.session-frames')
const FPS = 15
const ROWS = 34
const CHAT = 64 // columns of the chat
const PANE = 104 // the pane's body columns; from 96 the code view sits beside the tree
const TREE = Math.max(30, Math.min(48, Math.floor(PANE * 0.4)))
const CODE = PANE - TREE - 2
const PANE_BG = '#000000'
const TEXT = '#c9d1d9'
const ACCEPT = '#af87ff'

// ---------------------------------------------------------------- the project and the work

const PROJECT = [
  'README.md', 'package.json', 'tsconfig.json',
  'src/App.tsx', 'src/index.ts',
  'src/api/client.ts', 'src/api/users.ts',
  'src/auth/session.ts', 'src/auth/token.ts',
  'src/components/Button.tsx', 'src/components/Card.tsx', 'src/components/Header.tsx', 'src/components/index.ts',
  'src/utils/date.ts', 'src/utils/format.ts', 'src/utils/legacy-dates.ts',
  'tests/session.test.ts',
]

const SESSION = `import { useEffect, useState } from 'react'
import type { User } from '../api/users'
import { parseToken, type Token } from './token'

export interface Session {
  user: User
  token: Token
}

export function isExpired(session: Session): boolean {
  return Date.now() > session.token.expiresAt
}

export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    const raw = localStorage.getItem('session')
    if (!raw) return
    const stored = JSON.parse(raw)
    setSession({ user: stored.user, token: parseToken(stored.token) })
  }, [])

  return session && !isExpired(session) ? session : null
}
`

const BADGE = `import type { User } from '../api/users'
import { initials } from '../utils/format'

export function UserBadge({ user }: { user: User }) {
  return (
    <span className="user-badge">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" width={24} height={24} />
      ) : (
        <span className="initials">{initials(user.name)}</span>
      )}
      {user.name}
    </span>
  )
}
`

const INDEX = `export { Button } from './Button'
export { Card } from './Card'
export { Header } from './Header'
`

const FORMAT = `import { formatDate } from './legacy-dates'

export const formatJoined = (ms: number) => \`Joined \${formatDate(ms)}\`

export const initials = (name: string) =>
  name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()
`

const PROMPT = 'Add a 30s clock-skew margin to session expiry, a UserBadge component, and drop the legacy date helpers'

/** One tool call: what the chat shows, and what the pane sees. */
const STEPS = [
  { tool: 'Read', op: 'view', path: 'src/auth/session.ts', run: 650, result: 'Read 24 lines' },
  { tool: 'Read', op: 'view', path: 'src/auth/token.ts', run: 550, result: 'Read 10 lines' },
  {
    tool: 'Update', op: 'edit', path: 'src/auth/session.ts', run: 800,
    before: SESSION,
    after: SESSION.replace(
      'export function isExpired(session: Session): boolean {\n  return Date.now() > session.token.expiresAt',
      'const CLOCK_SKEW_MS = 30_000\n\nexport function isExpired(session: Session): boolean {\n  return Date.now() + CLOCK_SKEW_MS > session.token.expiresAt',
    ),
  },
  { tool: 'Write', op: 'create', path: 'src/components/UserBadge.tsx', run: 900, before: '', after: BADGE },
  { tool: 'Update', op: 'edit', path: 'src/components/index.ts', run: 600, before: INDEX, after: INDEX + "export { UserBadge } from './UserBadge'\n" },
  { tool: 'Update', op: 'edit', path: 'src/utils/format.ts', run: 600, before: FORMAT, after: FORMAT.replace("'./legacy-dates'", "'./date'") },
  { tool: 'Bash', op: 'delete', path: 'src/utils/legacy-dates.ts', run: 500, label: 'rm src/utils/legacy-dates.ts', result: '(No content)' },
]
const REPLY = 'Session expiry now allows 30s of clock skew, UserBadge is exported from the components, and the legacy date helpers are gone.'

// The timeline, in ms: type the prompt, think, then each call, each edit replayed in full before the next.
const TYPE_FROM = 700
const TYPE_MS = 32
const SUBMIT = TYPE_FROM + PROMPT.length * TYPE_MS + 500
let cursor = SUBMIT + 1200
for (const s of STEPS) {
  s.start = cursor
  s.end = cursor + s.run
  s.clip = s.after === undefined ? undefined : clipOf(s.path, s.before, s.after, s.end)
  cursor = s.end + (s.clip ? s.clip.dur + 900 : 450)
}
const TURN_END = cursor + 700
const DURATION = TURN_END + 6500

// ---------------------------------------------------------------- the pane

function treeFor(paths) {
  const entries = new Map()
  for (const p of paths) {
    const parts = p.split('/')
    parts.forEach((_, i) => {
      const sub = parts.slice(0, i + 1).join('/')
      if (!entries.has(sub)) entries.set(sub, { p: sub, d: i < parts.length - 1, m: 1 })
    })
  }
  return [...entries.values()]
}

/** The plugin's state at `t`, as its hooks would have left it. */
function stateAt(t) {
  let paths = [...PROJECT]
  const activity = {}
  const ghosts = {}
  let turn = t >= SUBMIT ? { ...emptyTurn(), phase: 'working', at: SUBMIT } : emptyTurn()
  for (const s of STEPS) {
    if (t < s.start) continue
    if (s.op === 'create' && !paths.includes(s.path)) paths.push(s.path)
    if (t < s.end) {
      activity[s.path] = { op: s.op, startedAt: s.start, running: 1 }
      continue
    }
    if (s.op === 'delete') {
      paths = paths.filter(p => p !== s.path)
      delete activity[s.path]
      ghosts[s.path] = { d: false, at: s.end }
    } else {
      activity[s.path] = { op: s.op, startedAt: s.start, endedAt: s.end, running: 0 }
    }
    turn = counted(turn, s.op, s.path)
  }
  if (t >= TURN_END) turn = { ...turn, phase: 'complete', at: TURN_END }
  const clips = STEPS.filter(s => s.clip && s.end <= t).map(s => s.clip)
  return { tree: treeFor(paths), activity, ghosts, turn, clip: currentClip(clips, t) }
}

const smoothIn = t => {
  const k = Math.min(1, Math.max(0, t))
  return k * k * (3 - 2 * k)
}
const width = segs => segs.reduce((w, s) => w + [...s.t].length, 0)
const pad = (segs, columns, bg) => [...segs, { t: ' '.repeat(Math.max(0, columns - width(segs))), bg }]

const folders = new Map()
let treeScroll = 0
let codeScroll = 0

/** The pane's rows, laid out as register.tsx does with the code view beside the tree. */
function paneAt(t) {
  const s = stateAt(t)
  const height = ROWS - 1
  const rule = (label, columns) => [{ t: '── ', c: FAINT }, { t: label, c: FAINT, b: true }, { t: ' ' + '─'.repeat(Math.max(0, columns - label.length - 4)), c: FAINT }]
  const split = s.clip !== undefined
  const treeColumns = split ? TREE : PANE

  const rows = buildRows({ tree: s.tree, activity: s.activity, ghosts: s.ghosts, now: t, columns: treeColumns, folders })
  const summary = summaryLines(s.turn, t, treeColumns - 4)
  const legend = legendLines(treeColumns)
  const chrome = 3 + 1 + legend.length + 1 + (summary.length > 0 ? summary.length + 2 : 0)
  const room = Math.max(3, height - chrome)
  treeScroll = scrollTo(treeScroll, rows, focusOf(s.activity), room)
  const visible = rows.slice(treeScroll, treeScroll + room)
  const below = Math.max(0, rows.length - treeScroll - room)
  const isWorking = focusOf(s.activity) !== undefined || s.turn.phase === 'working'

  const left = [
    headerLine(t, isWorking, 'acme-dashboard'),
    statusLine(s.activity, s.turn, t, s.tree.filter(e => !e.d).length, treeColumns),
    rule(treeScroll > 0 ? `tree ↑${treeScroll}` : 'tree', treeColumns),
    ...visible.map(r => r.segs),
  ]
  if (below > 0) left.push([{ t: `   ↓ ${below} more`, c: FAINT }])
  if (summary.length > 0) {
    const age = t - s.turn.at
    const card = Math.min(smoothIn(age / 500), s.turn.phase === 'complete' && age > 18_500 ? Math.max(0, (20_000 - age) / 1500) : 1)
    const border = mix(FAINT, COLOR.create, card * 0.8)
    left.push([{ t: '╭' + '─'.repeat(treeColumns - 2) + '╮', c: border }])
    for (const segs of summary) left.push([{ t: '│ ', c: border }, ...pad(segs, treeColumns - 4), { t: ' │', c: border }])
    left.push([{ t: '╰' + '─'.repeat(treeColumns - 2) + '╯', c: border }])
  }
  while (left.length < height - 1 - legend.length) left.push([])
  left.push(rule('legend', treeColumns), ...legend)

  if (!split) return left.map(l => pad(l, PANE, PANE_BG))
  const replay = codeLines(s.clip, t, CODE, height - 1, codeScroll)
  codeScroll = replay.scroll
  const right = [codeRule(s.clip, CODE), ...replay.lines]
  return left.map((l, i) => [...pad(l, TREE, PANE_BG), { t: '  ' }, ...pad(right[i] ?? [], CODE, PANE_BG)])
}

// ---------------------------------------------------------------- the chat, a mockup of Claude Code

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

function wrap(text, columns) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > columns) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

function chatAt(t) {
  const lines = []
  const box = (rows, c) => [
    [{ t: '╭' + '─'.repeat(CHAT - 2) + '╮', c }],
    ...rows.map(r => [{ t: '│ ', c }, ...pad(r, CHAT - 4), { t: ' │', c }]),
    [{ t: '╰' + '─'.repeat(CHAT - 2) + '╯', c }],
  ]
  lines.push(...box([
    [{ t: '✻ ', c: CLAUDE }, { t: 'Welcome to ', c: TEXT }, { t: 'Claude Code', c: TEXT, b: true }],
    [],
    [{ t: '  cwd: ~/Projects/acme-dashboard', c: MUTED }],
  ], CLAUDE))
  lines.push([])

  const log = []
  if (t >= SUBMIT) {
    const shown = wrap(PROMPT, CHAT - 4)
    shown.forEach((l, i) => log.push(pad([{ t: i === 0 ? '> ' : '  ', c: MUTED, bg: '#1c2128' }, { t: l, c: TEXT, bg: '#1c2128' }], CHAT, '#1c2128')))
    log.push([])
  }
  const blink = Math.floor(t / 450) % 2 === 0
  // Consecutive reads fold into one line, as Claude Code shows them with verbose off.
  const reads = STEPS.filter(s => s.tool === 'Read' && t >= s.start)
  if (reads.length > 0) {
    const running = reads.some(s => t < s.end)
    log.push([{ t: '● ', c: running ? (blink ? TEXT : MUTED) : COLOR.create }, { t: `Read ${reads.length} file${reads.length > 1 ? 's' : ''}`, c: TEXT, b: true }, { t: ' (ctrl+o to expand)', c: MUTED }])
    log.push([])
  }
  for (const s of STEPS) {
    if (s.tool === 'Read' || t < s.start) continue
    const running = t < s.end
    const arg = s.label ?? s.path
    log.push([{ t: '● ', c: running ? (blink ? TEXT : MUTED) : COLOR.create }, { t: s.tool, c: TEXT, b: true }, { t: `(${arg})`, c: TEXT }])
    if (!running) {
      if (s.clip) {
        const isNew = s.op === 'create'
        log.push([
          { t: '  ⎿  ', c: MUTED },
          { t: isNew ? `${ICON.create} Created ` : `${ICON.edit} Edited `, c: isNew ? COLOR.create : COLOR.edit },
          { t: s.path, c: TEXT, b: true },
          { t: ` +${s.clip.adds}`, c: COLOR.create },
          { t: ` -${s.clip.dels}`, c: COLOR.delete },
          { t: ' · in the work pane', c: MUTED },
        ])
      } else log.push([{ t: '  ⎿  ', c: MUTED }, { t: s.result, c: MUTED }])
    }
    log.push([])
  }
  if (t >= TURN_END - 300) {
    wrap(REPLY, CHAT - 2).forEach((l, i) => log.push([{ t: i === 0 ? '● ' : '  ', c: TEXT }, { t: l, c: TEXT }]))
    log.push([])
  }
  if (t >= SUBMIT && t < TURN_END - 300) {
    const secs = Math.floor((t - SUBMIT) / 1000)
    log.push([{ t: SPIN[Math.floor(t / 120) % SPIN.length] + ' ', c: CLAUDE }, { t: 'Clauding… ', c: CLAUDE }, { t: `(${secs}s · esc to interrupt)`, c: MUTED }])
  }

  const typed = t < TYPE_FROM ? '' : t >= SUBMIT ? '' : PROMPT.slice(0, Math.floor((t - TYPE_FROM) / TYPE_MS))
  const input = wrap(typed, CHAT - 6)
  const inputRows = (input.length ? input : ['']).map((l, i, all) => [
    { t: i === 0 ? '> ' : '  ', c: TEXT },
    { t: l, c: TEXT },
    ...(i === all.length - 1 ? [{ t: blink || typed.length < PROMPT.length ? '█' : ' ', c: TEXT }] : []),
  ])
  const bottom = [...box(inputRows, '#484f58'), [{ t: '  ⏵⏵ accept edits on', c: ACCEPT }, { t: ' (shift+tab to cycle)', c: MUTED }]]

  const room = ROWS - lines.length - bottom.length
  lines.push(...log.slice(Math.max(0, log.length - room)))
  while (lines.length < ROWS - bottom.length) lines.push([])
  lines.push(...bottom)
  return lines
}

// ---------------------------------------------------------------- painting

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const paint = lines => lines.map(segs => `<div class="l">${segs.map(s => {
  const style = [
    s.c ? `color:${s.c}` : '',
    s.bg ? `background:${s.bg}` : '',
    s.b ? 'font-weight:700' : '',
    s.s ? 'text-decoration:line-through' : '',
    s.dim ? 'opacity:.55' : '',
  ].filter(Boolean).join(';')
  return `<span style="${style}">${escape(s.t)}</span>`
}).join('')}&#8203;</div>`).join('')

// Separate columns, so a chat glyph drawn from a fallback font can't push the pane sideways.
function html(t) {
  const title = [{ t: ' Claude Work ', c: MUTED, b: true, bg: PANE_BG }]
  const sep = Array.from({ length: ROWS }, () => [{ t: ' │', c: FAINT }])
  return `<div id="chat">${paint(chatAt(t))}</div><div id="sep">${paint(sep)}</div><div id="pane">${paint([pad(title, PANE, PANE_BG), ...paneAt(t)])}</div>`
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=block" rel="stylesheet">
<style>
  html,body{margin:0;background:#010409}
  #win{display:inline-block;margin:20px;border-radius:10px;overflow:hidden;background:#0b0d10;
       box-shadow:0 0 0 1px #30363d,0 16px 40px rgba(0,0,0,.55)}
  #bar{height:30px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#161b22;border-bottom:1px solid #21262d}
  #bar i{width:12px;height:12px;border-radius:50%;display:block}
  #bar b{flex:1;text-align:center;font:500 12px 'JetBrains Mono',Menlo,monospace;color:#6e7681;margin-right:52px}
  #term{width:${CHAT + 2 + PANE}ch;height:${ROWS * 18}px;padding:10px 14px 12px;overflow:hidden;font:13px/18px 'JetBrains Mono',Menlo,monospace;color:${TEXT};white-space:pre;display:flex}
  #chat{width:${CHAT}ch;overflow:hidden}
  #sep{width:2ch}
  #pane{width:${PANE}ch;overflow:hidden}
  .l{height:18px}
  .l span{display:inline-block;height:18px;vertical-align:top;overflow:hidden}
</style></head><body><div id="win"><div id="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>claude · ~/Projects/acme-dashboard</b></div><div id="term"></div></div></body></html>`

async function main() {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright')
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })

  // PLAYWRIGHT_CHANNEL=chrome uses the installed Google Chrome instead of Playwright's download.
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.setContent(PAGE, { waitUntil: 'networkidle' }).catch(() => page.setContent(PAGE))
  await page.evaluate(() => document.fonts.ready)
  const win = page.locator('#win')

  const total = Math.round((DURATION / 1000) * FPS)
  for (let i = 0; i < total; i++) {
    const t = (i * 1000) / FPS
    await page.evaluate(h => { document.getElementById('term').innerHTML = h }, html(t))
    await win.screenshot({ path: join(FRAMES, `f${String(i).padStart(4, '0')}.png`) })
  }
  await browser.close()

  const gif = join(OUT, 'session.gif')
  const palette = join(FRAMES, 'palette.png')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, 'f%04d.png'),
    '-vf', 'palettegen=max_colors=256:stats_mode=full', palette])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, 'f%04d.png'), '-i', palette,
    '-lavfi', 'paletteuse=dither=none:diff_mode=rectangle', '-loop', '0', gif])
  rmSync(FRAMES, { recursive: true, force: true })
  console.log(`wrote ${gif}: ${total} frames, ${(DURATION / 1000).toFixed(1)} s`)
}

await main()
