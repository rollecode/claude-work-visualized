import { expect, mock, test } from 'claude-code/testing'

import {
  buildRows, classifyBash, diffTrees, emptyTurn, focusOf, mentionsOf, placeOf, relPath, remotePath, statusLine, summaryLines, T, thoughtLines,
  typeTo, withThought, wrapWords,
} from './model'
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
    { op: 'edit', path: '/etc/nginx/nginx.conf', host: 'deploy@web1' },
    { op: 'delete', path: '/tmp/old.log', host: 'deploy@web1' },
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
    { op: 'create', path: '/opt/app.tar.gz', host: 'root@web2' },
  ])
  expect(classifyBash('cat > notes.md <<EOF\nrm -rf /\nEOF')).toEqual([{ op: 'edit', path: 'notes.md' }])
  expect(remotePath('web1', '/etc/./nginx/../hosts')).toBe('web1:/etc/hosts')
  expect(remotePath('web1', 'logs/app.log')).toBe('web1:/~/logs/app.log')
  expect(remotePath('web1', '$HOME/x')).toBe('web1:/~/x')
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
  expect(shown).toContain('→ web1')
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

test('paths outside the session folder go under the home folder or the disk', async () => {
  expect(placeOf('/home/u/site', 'src/a.ts', '/home/u')).toEqual({ file: '/home/u/site/src/a.ts', path: 'src/a.ts' })
  expect(placeOf('/home/u/site', '~/Projects/other/x.php', '/home/u')).toEqual({ file: '/home/u/Projects/other/x.php', path: '~:/Projects/other/x.php' })
  expect(placeOf('/home/u/site', '../other/y.php', '/home/u')).toEqual({ file: '/home/u/other/y.php', path: '~:/other/y.php' })
  expect(placeOf('/home/u/site', '/etc/hosts', '/home/u')).toEqual({ file: '/etc/hosts', path: 'local:/etc/hosts' })
  expect(placeOf('/home/u/site', 'node_modules/x.js', '/home/u')).toBe(undefined)
  expect(placeOf('/home/u/site', '$F', '/home/u')).toBe(undefined)
})

test('a for loop runs its body once per value', async () => {
  const command = [
    "cd ~/site && python3 - <<'EOF'",
    "p='CHANGELOG.md'",
    "open(p,'w').write(open(p).read())",
    'EOF',
    'K="-i $HOME/.ssh/id_rsa -o IdentitiesOnly=yes"; for h in web1 web2; do scp -q $K CHANGELOG.md $h:~/site/CHANGELOG.md && printf "%s ok " $h; done; echo',
  ].join('\n')
  expect(classifyBash(command)).toEqual([
    { op: 'view', path: '~/site/CHANGELOG.md' },
    { op: 'create', path: '~/site/CHANGELOG.md', host: 'web1' },
    { op: 'view', path: '~/site/CHANGELOG.md' },
    { op: 'create', path: '~/site/CHANGELOG.md', host: 'web2' },
  ])
  expect(remotePath('web1', '$HOME/x.log')).toBe('web1:/~/x.log')
  expect(placeOf('/home/u/site', '$HOME/notes.md', '/home/u')).toEqual({ file: '/home/u/notes.md', path: '~:/notes.md' })
})

test('a sed edit in another project shows in the tree and replays in the code view', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const disk: Record<string, string> = { '/home/u/other/inc/hooks.php': '<?php\n$id = $term->term_id;\n' }
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) =>
    ({ value: e.path === ROOT ? [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [] }) as never,
  )
  on('fs.stat', ($, e) => (disk[e.path] === undefined ? { deny: 'missing' } : { value: { kind: 'file', size: disk[e.path]?.length ?? 0, mtimeMs: 1, isLink: false } }) as never)
  on('fs.read', ($, e) => (disk[e.path] === undefined ? { deny: 'missing' } : { value: disk[e.path] }) as never)
  on('tool.call', { tool: 'Bash' }, () => {
    disk['/home/u/other/inc/hooks.php'] = '<?php\n$id = $term->term_id ?? null;\n'
    return { result: { stdout: '', stderr: '', interrupted: false }, isError: true } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.tool.call({ tool: 'Bash', command: "cd ~/other && F=inc/hooks.php && sed -i '' -e 's/id;/id ?? null;/' $F && git diff | grep nothing" } as never)

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('~:/')
  expect(shown).toContain('hooks.php')
  expect(shown).toContain('~:/other/inc/hooks.php:1')
  await ui.unmount()
})

test('files a script names are checked, so a heredoc that rewrites one is caught', async () => {
  const command = ["cd ~/site && python3 - <<'EOF'", "p='CHANGELOG.md'", "open(p,'w').write(open(p).read())", 'EOF', 'grep -c x CHANGELOG.md; echo v1.2.3'].join('\n')
  expect(mentionsOf(command)).toEqual(['~/site', '~/site/CHANGELOG.md'])
  expect(mentionsOf("ssh web1 'cat /etc/hosts'")).toEqual([])
})

test('a changelog rewritten by a python heredoc replays in the code view', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const disk: Record<string, string> = { '/home/u/site/CHANGELOG.md': '### alpha\n\n* beta\n' }
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) =>
    ({ value: e.path === ROOT ? [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [] }) as never,
  )
  on('fs.stat', ($, e) => (disk[e.path] === undefined ? { deny: 'missing' } : { value: { kind: 'file', size: disk[e.path]?.length ?? 0, mtimeMs: 1, isLink: false } }) as never)
  on('fs.read', ($, e) => (disk[e.path] === undefined ? { deny: 'missing' } : { value: disk[e.path] }) as never)
  on('tool.call', { tool: 'Bash' }, () => {
    disk['/home/u/site/CHANGELOG.md'] = '### alpha\n\n* alpha: Guard a missing query arg\n* beta\n'
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  const command = ["cd ~/site && python3 - <<'EOF'", "p='CHANGELOG.md'", "s=open(p).read()", "open(p,'w').write(s)", 'EOF'].join('\n')
  await $.tool.call({ tool: 'Bash', command } as never)

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('~:/site/CHANGELOG.md:1')
  expect(shown).toContain('CHANGELOG.md')
  await ui.unmount()
})

test('paths sliding in or out of a cut-off scan are not created or deleted', async () => {
  const before = [
    { p: 'a', d: true, m: 0 },
    { p: 'a/1.ts', d: false, m: 1 },
    { p: 'b', d: true, m: 0 },
    { p: 'b/x.ts', d: false, m: 1 },
  ]
  // A new file in `a` pushed `b/x.ts` past the scan's limit, and `b` came back cut off.
  const after = [
    { p: 'a', d: true, m: 0 },
    { p: 'a/0.ts', d: false, m: 1 },
    { p: 'a/1.ts', d: false, m: 1 },
    { p: 'b', d: true, m: 0 },
    { p: 'b/w.ts', d: false, m: 1 },
  ]
  const diff = diffTrees(before, after, { before: new Set(['', 'a']), after: new Set(['', 'a']) })
  expect(diff.created.map(t => t.p)).toEqual(['a/0.ts'])
  expect(diff.deleted.map(t => t.p)).toEqual([])
})

test('changes the rescan finds after the turn ends are not counted for it', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  const files = [{ name: 'a.ts', kind: 'file' as const }]
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) => ({ value: e.path === ROOT ? files.map(f => ({ ...f, size: 1, mtimeMs: 1, isLink: false })) : [] }) as never)
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await clock.advance(2000)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', isAborted: false } as never)
  files.push({ name: 'b.ts', kind: 'file' }) // a git hook, an editor: not Claude
  await clock.advance(3000)

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('TASK COMPLETE')
  expect(shown).toContain('b.ts')
  expect(shown).toContain('created   0')
  await ui.unmount()
})

test('only changes that follow Claude\'s own tool calls count on the card', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  const files = [{ name: 'a.ts', kind: 'file' as const }]
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) => ({ value: e.path === ROOT ? files.map(f => ({ ...f, size: 1, mtimeMs: 1, isLink: false })) : [] }) as never)
  on('tool.call', { tool: 'Bash' }, () => {
    files.push({ name: 'built.js', kind: 'file' }) // what Claude's command made
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await clock.advance(2000)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  files.push({ name: 'other.log', kind: 'file' }) // another program, mid-turn
  await clock.advance(2000)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as never)
  await clock.advance(500)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', isAborted: false } as never)
  await clock.advance(2000)

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('other.log')
  expect(shown).toContain('created   1')
  await ui.unmount()
})

test('thinking is kept as one line, a new block starting over', async () => {
  const a = withThought(null, 'k1', '  Let me\n\nlook', 0)
  expect(a.text).toBe('Let me look')
  const b = withThought(a, 'k1', ' at  this.', 10)
  expect(b.text).toBe('Let me look at this.')
  expect(withThought(b, 'k2', 'Next.', 20)).toEqual({ key: 'k2', text: 'Next.', dropped: 0, at: 20 })
})

test('the typewriter keeps a steady pace and catches up when behind', async () => {
  expect(typeTo(0, 10, 33)).toBeLessThan(10)
  expect(typeTo(0, 10, 2000)).toBe(10)
  expect(typeTo(0, 4000, 1000)).toBe(4000)
  expect(typeTo(5, 5, 33)).toBe(5)
})

test('thinking wraps to the pane, shows its last lines and fades once done', async () => {
  expect(wrapWords('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrapWords('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  const long = withThought(null, 'k', 'word '.repeat(60), 0)
  const lines = thoughtLines(long, 10_000, 100, 30)
  expect(lines.length).toBe(3)
  for (const l of lines) expect(text(l).length).toBeLessThanOrEqual(30)
  expect(text(lines[2] ?? [])).toContain('▏')
  const half = thoughtLines(withThought(null, 'k', 'Reading the config', 0), 7, 100, 40)
  expect(text(half.flat())).toBe(' Reading▏')
  const done = { ...withThought(null, 'k', 'Done.', 0), endedAt: 1000 }
  expect(text(thoughtLines(done, 5, 2000, 40).flat())).toBe(' Done.')
  expect(thoughtLines(done, 5, 1000 + T.thoughtLinger + T.thoughtFade + 1, 40)).toEqual([])
  expect(thoughtLines(withThought(null, 'k', '', 0), 0, 100, 40)).toEqual([])
})

test('thinking streamed in a step types itself into the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'Checking how the\nconfig is loaded' }
    yield { kind: 'text', index: 1, text: 'Done.' }
    return { turnId: 't1', index: 0, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  const chunks: unknown[] = []
  let step = await stream.next()
  for (; step.done !== true; step = await stream.next()) chunks.push(step.value)
  expect(chunks.length).toBe(2)
  expect(step.value.answer).toBe('Done.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    await clock.advance(2000)
    await ui.unmount()
    const again = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const shown = (await again.findAll({ type: 'Text' })).map(x => x.text).join('')
    expect(shown).toContain('thinking')
    expect(shown).toContain('Checking how the config is loaded')
    await again.unmount()
  }
})
