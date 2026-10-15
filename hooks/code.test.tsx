import { expect, mock, test } from 'claude-code/testing'

import { HOLD, cellSafe, clipOf, codeLines, coloursOf, currentClip, enqueue, frameOf, grammarOf, hunksOf } from './code'

const ROOT = '/proj'
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'
const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')
const rowsAt = (clip: NonNullable<ReturnType<typeof clipOf>>, now: number) => frameOf(clip, now).rows

test('a diff finds each changed region', async () => {
  expect(hunksOf(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([{ a0: 1, a1: 2, b0: 1, b1: 2 }])
  expect(hunksOf(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ a0: 1, a1: 1, b0: 1, b1: 2 }])
  expect(hunksOf(['a', 'b', 'c', 'd', 'e'], ['x', 'b', 'c', 'd', 'y'])).toHaveLength(2)
  expect(hunksOf(['a'], ['a'])).toEqual([])
})

test('a clip keeps a window of context around the change', async () => {
  const before = lines(40)
  const after = before.replace('line 20\n', 'line twenty\n')
  const clip = clipOf('src/a.ts', before, after, 0)
  expect(clip?.first).toBe(17)
  expect(clip?.before).toEqual(['line 17', 'line 18', 'line 19', 'line 20', 'line 21', 'line 22', 'line 23'])
  expect(clip?.after[3]).toBe('line twenty')
  expect([clip?.adds, clip?.dels]).toEqual([1, 1])
  expect(clipOf('src/a.ts', before, before, 0)).toBe(undefined)
  expect(clipOf('big.ts', 'x'.repeat(300 * 1024), 'y', 0)).toBe(undefined)
})

test('a small change is selected, backspaced and retyped in place', async () => {
  const clip = clipOf('a.ts', 'const a = 1\nconst speed = 10\nconst b = 2\n', 'const a = 1\nconst speed = 25\nconst b = 2\n', 0)
  if (clip === undefined) throw new Error('no clip')
  let sawSelection = false
  let sawCaret = false
  for (let t = 0; t < clip.dur; t += 10) {
    const rows = rowsAt(clip, t)
    expect(rows).toHaveLength(3)
    if (rows[1]?.m?.isSelected) sawSelection = true
    if (rows[1]?.c !== undefined) sawCaret = true
  }
  expect(sawSelection && sawCaret).toBe(true)
  expect(rowsAt(clip, clip.dur + 1).map(r => r.t)).toEqual(['const a = 1', 'const speed = 25', 'const b = 2'])
  expect(rowsAt(clip, clip.dur + 1)[1]?.r).toBe('mod')
})

test('a replaced block goes red, the new lines type in, then the red folds away', async () => {
  const clip = clipOf('a.py', 'def f():\n    return 1\n', 'def f():\n    x = compute()\n    log(x)\n    return x\n', 0)
  if (clip === undefined) throw new Error('no clip')
  const kinds = new Set<string>()
  let typedPartly = false
  for (let t = 0; t < clip.dur; t += 10) {
    const rows = rowsAt(clip, t)
    for (const r of rows) kinds.add(r.k)
    if (rows.some(r => r.k === 'add' && r.c !== undefined && r.t.length > 0 && !clip.after.includes(r.t))) typedPartly = true
  }
  expect(kinds.has('del') && kinds.has('add')).toBe(true)
  expect(typedPartly).toBe(true)
  expect(rowsAt(clip, clip.dur + 1).map(r => r.t)).toEqual(clip.after)
})

test('a long write still replays within a few seconds', async () => {
  const clip = clipOf('new.ts', '', lines(500, i => `export const value${i} = ${i} // some longer text here`), 0)
  expect(clip?.after).toHaveLength(80)
  expect(clip?.more).toBe(420)
  expect(clip?.dur ?? Infinity).toBeLessThan(5000)
})

test('code lines are one cell per character and never wider than the pane', async () => {
  expect(cellSafe('\tok')).toBe('  ok')
  expect(cellSafe('done ✅ 漢')).toBe('done · ·')
  const before = 'function greet(name) {\n\treturn "hi " + name // a rather long comment that runs past the pane edge\n}\n'
  const after = before.replace('"hi "', '"hello, 😀 "')
  const clip = clipOf('a.js', before, after, 0)
  if (clip === undefined) throw new Error('no clip')
  for (const columns of [24, 40, 60]) {
    for (let t = 0; t < clip.dur + 9000; t += 23) {
      for (const segs of codeLines(clip, t, columns, 10).lines) {
        expect([...text(segs)].length).toBeLessThanOrEqual(columns)
        for (const s of segs) expect(/\p{Extended_Pictographic}/u.test(s.t)).toBe(false)
      }
    }
  }
})

test('edits in a row queue up, and a backlog is cut short', async () => {
  const a = clipOf('a.ts', 'x\n', 'y\n', 0)
  const b = clipOf('b.ts', 'x\n', 'z\n', 0)
  if (a === undefined || b === undefined) throw new Error('no clip')
  const queued = enqueue(enqueue([], a, 1000), b, 1000)
  expect(queued[1]?.at).toBe(1000 + a.dur)
  expect(currentClip(queued, 1000)?.path).toBe('a.ts')
  expect(currentClip(queued, 1000 + a.dur)?.path).toBe('b.ts')
  expect(currentClip(queued, 1000 + a.dur + b.dur + HOLD)).toBe(undefined)
  const slow = { ...a, dur: 10_000 }
  expect(enqueue([{ ...slow, at: 0 }], b, 100)[1]?.at).toBe(100)
})

test('an Edit replays in the pane under the tree', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  const disk: Record<string, string> = { '/proj/a.ts': 'const a = 1\nconst b = 2\n' }
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', ($, e) =>
    ({ value: e.path === ROOT ? [{ name: 'a.ts', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [] }) as never,
  )
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: (disk[e.path] ?? '').length, mtimeMs: 1, isLink: false } }) as never)
  on('fs.read', ($, e) => (disk[e.path] === undefined ? { error: 'missing' } : { value: disk[e.path] }) as never)
  on('tool.call', { tool: 'Edit' }, () => {
    disk['/proj/a.ts'] = 'const a = 1\nconst b = 3\n'
    return { result: {} } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'b = 2', new_string: 'b = 3' } as never)

  const ui = await $.ui.mount({
    plugin: 'work-visualized',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-map',
    props: { title: 'Claude Work', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
  expect(shown).toContain('a.ts:1')
  expect(shown).toContain('const a = 1')
  await ui.unmount()
})

test('each language gets its own grammar, in Tokyo Night colours', async () => {
  expect(grammarOf('src/a.php')).toBe('php')
  expect(grammarOf('web/app.tsx')).toBe('tsx')
  expect(grammarOf('Dockerfile')).toBe('docker')
  expect(grammarOf('/etc/nginx/sites/app.conf')).toBe('nginx')
  expect(grammarOf('notes.txt')).toBe(undefined)
  const php = '<?php\n// note\n$id = $term->term_id ?? null;\n'
  const c = coloursOf(php, 'php')
  expect(c).toHaveLength(php.length)
  expect(c[php.indexOf('// note')]).toBe('#565f89')
  expect(c[php.indexOf('null')]).toBe('#ff9e64')
  const md = coloursOf('# Title\n- [link](a.md) use it', 'markdown')
  expect(md['# Title\n- [link](a.md) '.length]).toBe('#c0caf5') // "use" is not a keyword in Markdown
})

test('a long line wraps instead of running off the pane', async () => {
  const long = 'const message = "' + 'x'.repeat(70) + '"'
  const clip = clipOf('a.ts', 'const a = 1\n', 'const a = 1\n' + long + '\n', 0)
  if (clip === undefined) throw new Error('no clip')
  const { lines } = codeLines(clip, clip.dur + 1, 40, 20)
  const shown = lines.map(l => text(l))
  expect(shown.some(l => l.includes('↳'))).toBe(true)
  expect(shown.join('').replace(/[^x]/g, '').length).toBe(70)
  for (const l of shown) expect([...l].length).toBeLessThanOrEqual(40)
})

test('an edit shows as one line in the chat while the work pane shows it', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  let panes = [{ id: 'work-map', title: 'Claude Work', isShown: true, isFocused: false, isPlaced: true }]
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: panes }) as never)
  // The engine's own drawing, beneath the plugin: the full diff.
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>full diff: new line</Text>
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)

  const output = {
    filePath: '/proj/src/a.ts',
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old line', '+new line', '+another'] }],
  }
  const draw = async () => {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'call-1',
      props: { tool_use_id: 'call-1', tool: 'Edit', output, isErrored: false },
    })
    const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
    await ui.unmount()
    return shown
  }
  const quiet = await draw()
  expect(quiet).toContain('src/a.ts')
  expect(quiet).toContain('+2 -1')
  expect(quiet).not.toContain('new line')

  panes = []
  expect(await draw()).not.toContain('+2 -1')
})
