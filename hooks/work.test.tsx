import { expect, mock, test } from 'claude-code/testing'

import { buildRows, classifyBash, diffTrees, emptyTurn, focusOf, relPath, remotePath, statusLine, summaryLines, T } from './model'
import type { FolderMemory } from './model'

// The test environment has it; the engine's typings leave it out.
declare function setTimeout(run: () => void, ms: number): unknown

const ROOT = '/proj'
const FILES: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '': [
    { name: 'src', kind: 'dir' },
    { name: 'package.json', kind: 'file' },
    { name: 'node_modules', kind: 'dir' },
  ],
  src: [
    { name: 'auth', kind: 'dir' },
    { name: 'index.ts', kind: 'file' },
  ],
  'src/auth': [
    { name: 'session.ts', kind: 'file' },
    { name: 'types.ts', kind: 'file' },
  ],
}

const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')

test('paths are made relative and ignored folders dropped', async () => {
  expect(relPath(ROOT, '/proj/src/a.ts')).toBe('src/a.ts')
  expect(relPath(ROOT, '/proj/./src/../b.ts')).toBe('b.ts')
  expect(relPath(ROOT, '/elsewhere/a.ts')).toBe(undefined)
  expect(relPath(ROOT, '/proj/node_modules/x/index.js')).toBe(undefined)
})

test('shell commands are read for views, edits, creates and deletes', async () => {
  expect(classifyBash('cat src/a.ts | grep foo src/b.ts')).toEqual([
    { op: 'view', path: 'src/a.ts' },
    { op: 'view', path: 'src/b.ts' },
  ])
  expect(classifyBash('rm -rf dist old.ts && touch new.ts')).toEqual([
    { op: 'delete', path: 'dist' },
    { op: 'delete', path: 'old.ts' },
    { op: 'create', path: 'new.ts' },
  ])
  expect(classifyBash("sed -i 's/a/b/' src/x.ts")).toEqual([{ op: 'edit', path: 'src/x.ts' }])
  expect(classifyBash('echo hi > notes.md')).toEqual([{ op: 'edit', path: 'notes.md' }])
  expect(classifyBash('git mv a.ts b.ts')).toEqual([
    { op: 'delete', path: 'a.ts' },
    { op: 'create', path: 'b.ts' },
  ])
})

test('a scan diff finds created, edited and deleted paths, one ghost per deleted folder', async () => {
  const before = [
    { p: 'a.ts', d: false, m: 1 },
    { p: 'lib', d: true, m: 0 },
    { p: 'lib/x.ts', d: false, m: 1 },
  ]
  const after = [
    { p: 'a.ts', d: false, m: 2 },
    { p: 'b.ts', d: false, m: 1 },
  ]
  const diff = diffTrees(before, after)
  expect(diff.created.map(t => t.p)).toEqual(['b.ts'])
  expect(diff.edited).toEqual(['a.ts'])
  expect(diff.deleted.map(t => t.p)).toEqual(['lib'])
})

test('the running file is the focus, with the strongest marker and its folders lit', async () => {
  const tree = [
    { p: 'src', d: true, m: 0 },
    { p: 'src/a.ts', d: false, m: 1 },
    { p: 'src/b.ts', d: false, m: 1 },
  ]
  const activity = {
    'src/a.ts': { op: 'view' as const, startedAt: 0, endedAt: 500, running: 0 },
    'src/b.ts': { op: 'edit' as const, startedAt: 900, running: 1 },
  }
  expect(focusOf(activity)).toBe('src/b.ts')
  const folders: FolderMemory = new Map()
  const rows = buildRows({ tree, activity, ghosts: {}, now: 1000, columns: 40, folders })
  expect(rows.map(r => r.path)).toEqual(['src', 'src/a.ts', 'src/b.ts'])
  expect(text(rows[2]?.segs ?? [])).toContain('◂ editing')
  expect(text(rows[2]?.segs ?? [])).toContain('└╴')
  expect(text(rows[0]?.segs ?? [])).toContain('●')
  expect(text(rows[1]?.segs ?? [])).toContain('✓')
})

test('a deleted file shakes, fades, then leaves the tree', async () => {
  const tree = [{ p: 'keep.ts', d: false, m: 1 }]
  const ghosts = { 'gone.ts': { d: false, at: 0 } }
  const at = (now: number) => buildRows({ tree, activity: {}, ghosts, now, columns: 40, folders: new Map() })
  expect(at(100).map(r => r.path)).toEqual(['gone.ts', 'keep.ts'])
  expect(at(100)[0]?.segs.some(s => s.bg !== undefined)).toBe(true)
  expect(at(1500)[0]?.segs.some(s => s.s === true)).toBe(true)
  expect(at(T.ghostGone + 1).map(r => r.path)).toEqual(['keep.ts'])
})

test('every glyph in a row is one cell, so columns line up at any frame', async () => {
  const tree = [
    { p: 'src', d: true, m: 0 },
    { p: 'src/a.ts', d: false, m: 1 },
  ]
  for (const op of ['view', 'edit', 'create', 'delete'] as const) {
    for (let now = 0; now < 3000; now += 37) {
      const rows = buildRows({ tree, activity: { 'src/a.ts': { op, startedAt: 0, running: 1 } }, ghosts: {}, now, columns: 40, folders: new Map() })
      for (const r of rows) for (const s of r.segs) expect(/\p{Extended_Pictographic}/u.test(s.t) && s.t !== '✓' && s.t !== '✗').toBe(false)
      expect(text(rows[1]?.segs ?? []).length).toBeLessThanOrEqual(40)
    }
  }
})

test('the prompt line never runs past the pane, however long the path', async () => {
  const activity = { 'src/components/some/deeply/nested/UserProfileSettings.tsx': { op: 'create' as const, startedAt: 0, running: 1 } }
  for (const columns of [24, 40, 46, 80]) {
    expect(text(statusLine(activity, emptyTurn(), 1234, 10, columns)).length).toBeLessThanOrEqual(columns)
  }
})

test('the completion card counts up and then goes', async () => {
  const turn = {
    phase: 'complete' as const,
    at: 0,
    counts: { view: ['a', 'b', 'c'], edit: ['a'], create: [], delete: [] },
  }
  expect(text(summaryLines(turn, 2000).flat())).toContain('viewed    3')
  expect(text(summaryLines(turn, 2000).flat())).toContain('edited    1')
  expect(summaryLines(turn, T.summary + 1)).toEqual([])
})

test('a Read shows in the pane as Claude viewing that file', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) => {
    const rel = !e.path || e.path === '' || e.path === '.' || e.path === ROOT ? '' : e.path.replace(/^\/proj\//, '')
    return { value: (FILES[rel] ?? []).map(f => ({ ...f, size: 1, mtimeMs: f.kind === 'file' ? 1 : 0, isLink: false })) }
  })
  let release = () => {}
  let reached = () => {}
  const arrived = new Promise<void>(r => (reached = r))
  on('tool.call', { tool: 'Read' }, () =>
    new Promise(resolve => {
      reached()
      release = () => resolve({ result: { type: 'text', file: { filePath: '/proj/src/auth/session.ts', content: '', numLines: 0, startLine: 1, totalLines: 0 } } } as never)
    }),
  )
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  const off = await $.command.run({ command: 'watch', args: '' } as never)
  expect(JSON.stringify(off)).toContain('is off')
  const back = await $.command.run({ command: 'watch', args: '' } as never)
  expect(JSON.stringify(back)).toContain('is on')

  const reading = $.tool.call({ tool: 'Read', file_path: '/proj/src/auth/session.ts' } as never)
  await arrived

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
    expect(shown).toContain('work-map ~/proj')
    expect(shown).toContain('reading src/auth/session.ts')
    expect(shown).toContain('◂ reading')
    expect(shown).not.toContain('node_modules')
    expect(shown).toContain('✗ delete')
    await ui.unmount()
  }
  release()
  await reading
})

test('commands run over ssh, scp and rsync are read as work on that host', async () => {
  expect(classifyBash("ssh -p 2222 -i ~/.ssh/key deploy@web1 'sudo sed -i s/a/b/ /etc/nginx/nginx.conf && rm -f /tmp/old.log'")).toEqual([
    { op: 'edit', path: '/etc/nginx/nginx.conf', host: 'web1' },
    { op: 'delete', path: '/tmp/old.log', host: 'web1' },
  ])
  expect(classifyBash('ssh web1 cat /var/log/app.log | grep error > errors.txt')).toEqual([
    { op: 'view', path: '/var/log/app.log', host: 'web1' },
    { op: 'edit', path: 'errors.txt' },
  ])
  expect(classifyBash("ssh web1 bash -s <<'EOF'\ntouch /srv/app/ready\nrm /srv/app/lock\nEOF\nls")).toEqual([
    { op: 'create', path: '/srv/app/ready', host: 'web1' },
    { op: 'delete', path: '/srv/app/lock', host: 'web1' },
  ])
  expect(classifyBash("ssh web1 'cat > /etc/motd' <<EOF\nrm everything\nEOF")).toEqual([{ op: 'edit', path: '/etc/motd', host: 'web1' }])
  expect(classifyBash('scp dist/app.tar.gz root@web2:/opt/app.tar.gz')).toEqual([
    { op: 'view', path: 'dist/app.tar.gz' },
    { op: 'create', path: '/opt/app.tar.gz', host: 'web2' },
  ])
  expect(classifyBash('cat > notes.md <<EOF\nrm -rf /\nEOF')).toEqual([{ op: 'edit', path: 'notes.md' }])
  expect(remotePath('web1', '/etc/./nginx/../hosts')).toBe('web1:/etc/hosts')
  expect(remotePath('web1', 'logs/app.log')).toBe('web1:/~/logs/app.log')
  expect(remotePath('web1', '$HOME/x')).toBe(undefined)
})

test('a file deleted over ssh shows under its host and plays its exit', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) =>
    ({ value: e.path === ROOT ? [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [] }) as never,
  )
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.tool.call({ tool: 'Bash', command: "ssh web1 'sed -i s/a/b/ /etc/app.conf && rm /tmp/old.log'" } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never) // a rescan after the ssh call
  await new Promise<void>(resolve => setTimeout(resolve, 100))

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('web1:/')
  expect(shown).toContain('app.conf')
  expect(shown).toContain('old.log')
  expect(shown).toContain('package.json')
  await ui.unmount()
})

test('cd and variables set earlier in a command lead to the files after them', async () => {
  expect(classifyBash("cd ~/Projects/site && F=web/inc/hooks.php && sed -i '' -e '18s/\\$a->id;/\\$a->id ?? null;/' -e '21s/x/y/' $F && git diff | grep '^[+-] '")).toEqual([
    { op: 'edit', path: '~/Projects/site/web/inc/hooks.php' },
  ])
  expect(classifyBash('cd lib; cat a.ts > ../b.ts; cd -; rm c.ts')).toEqual([
    { op: 'edit', path: 'lib/../b.ts' },
    { op: 'view', path: 'lib/a.ts' },
    { op: 'delete', path: 'c.ts' },
  ])
  expect(classifyBash("perl -pi -e 's/a/b/' x.txt y.txt")).toEqual([
    { op: 'edit', path: 'x.txt' },
    { op: 'edit', path: 'y.txt' },
  ])
  expect(classifyBash("sed -i 's/a/b/' z.txt")).toEqual([{ op: 'edit', path: 'z.txt' }])
})
