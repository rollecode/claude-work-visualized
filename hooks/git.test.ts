import { expect, mock, test } from 'claude-code/testing'

import { gitActionsOf, gitEnded, gitStarted, gitView, parseGraph, prBaseOf, prNumberOf, refsAfter } from './git'

const ROOT = '/proj'
const R = '\x1e'
const F = '\x1f'
const GRAPH = [
  `* ${R}b2${F}HEAD -> feature${F}Add the thing`,
  `* ${R}b1${F}${F}Start the thing`,
  `| * ${R}m2${F}origin/main, main${F}Fix main`,
  `|/  `,
  `* ${R}a1${F}tag: v1.0${F}First`,
].join('\n')

// The same repository before the commit: HEAD on b1.
const BEFORE = GRAPH.split('\n').slice(1).join('\n').replace(`b1${F}${F}`, `b1${F}HEAD -> feature${F}`)

const text = (segs: { t: string }[]) => segs.map(s => s.t).join('')

test('git and gh commands are read for the actions that move branches', async () => {
  expect(gitActionsOf('git status && git diff')).toEqual([])
  expect(gitActionsOf('git checkout -b feature main')).toEqual([{ kind: 'checkout', ref: 'feature' }])
  expect(gitActionsOf('git switch main')).toEqual([{ kind: 'checkout', ref: 'main' }])
  expect(gitActionsOf('git checkout -- src/a.ts')).toEqual([])
  expect(gitActionsOf('git add a.ts && git commit -m "Fix it; really"')).toEqual([{ kind: 'commit' }])
  expect(gitActionsOf('git -C repo merge --no-ff feature')).toEqual([{ kind: 'merge', ref: 'feature' }])
  expect(gitActionsOf('git push origin HEAD')).toEqual([{ kind: 'push', ref: 'origin' }])
  expect(gitActionsOf('git branch -D old')).toEqual([])
  expect(gitActionsOf('gh pr create --base main --title x')).toEqual([{ kind: 'pr' }])
  expect(gitActionsOf('gh pr merge 12 --squash')).toEqual([{ kind: 'pr-merge', ref: '12' }])
  expect(prNumberOf('https://github.com/o/r/pull/12\n')).toBe(12)
  expect(prBaseOf('gh pr create --base main --title x')).toBe('main')
})

test('a checkout keeps the branch it came from beside HEAD', async () => {
  expect(refsAfter([], { kind: 'checkout', ref: 'feature' }, 'main')).toEqual(['main'])
  expect(refsAfter(['main'], { kind: 'merge', ref: 'fix' }, 'main')).toEqual(['fix', 'main'])
  expect(refsAfter(['a', 'b', 'c'], { kind: 'branch', ref: 'd' }, 'x')).toEqual(['d', 'a', 'b'])
})

test('the graph is parsed into one-cell glyphs, refs and subjects', async () => {
  const rows = parseGraph(GRAPH)
  expect(rows.map(r => r.graph)).toEqual(['●', '●', '│ ●', '│╱', '●'])
  expect(rows[0]).toEqual({ graph: '●', hash: 'b2', refs: ['feature'], subject: 'Add the thing', isHead: true })
  expect(rows[2]?.refs).toEqual(['origin/main', 'main'])
  expect(rows[4]?.refs).toEqual(['#v1.0'])
})

test('the view labels HEAD with the running action, pops new commits in, and fades', async () => {
  const before = gitEnded(gitStarted(null, { kind: 'commit' }, 0), { rows: parseGraph(BEFORE) }, [], false, 0)
  const running = gitStarted(before, { kind: 'commit' }, 1000)
  const shown = gitView(running, 1100, 50, 8)
  expect(text(shown.lines.flat())).toContain('◂ + commit')
  const done = gitEnded(running, { rows: parseGraph(GRAPH), ahead: 2 }, [], false, 2000)
  expect(done.fresh).toEqual(['b2'])
  expect(done.head).toBe('feature')
  const view = gitView(done, 2100, 50, 8)
  expect(view.label).toBe('git feature 2 ahead')
  expect(text(view.lines[0] ?? [])).toContain('feature')
  expect(text(view.lines[0] ?? [])).toContain('+ commit')
  for (const line of view.lines) expect(text(line).length).toBeLessThanOrEqual(49)
  expect(gitView(done, 2000 + 70_000, 50, 8).lines).toEqual([])
})

test('a PR card shows under the graph', async () => {
  const done = { ...gitEnded(gitStarted(null, { kind: 'pr' }, 0), { rows: parseGraph(GRAPH) }, [], false, 0), pr: { number: 4, head: 'feature', base: 'main', state: 'open' as const, at: 0 } }
  const lines = gitView(done, 1000, 40, 10).lines.map(text)
  expect(lines.some(l => l.includes('#4 open'))).toBe(true)
  expect(lines.some(l => l.includes('feature → main'))).toBe(true)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(39)
})

test('a commit Claude runs shows on the graph in the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  let committed = false
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv.includes('log')) return { value: { exitCode: 0, stdout: committed ? GRAPH : BEFORE, stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '1\t0\n', stderr: '' } } as never
  })
  on('tool.call', { tool: 'Bash' }, () => {
    committed = true
    return { result: { stdout: '[feature b2] Add the thing', stderr: '' } } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add the thing"' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-visualized',
      surface,
      component: 'Pane',
      requestId: 'work-map',
      props: { title: 'Claude Work', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    await clock.advance(500)
    const shown = (await ui.findAll({ type: 'Text' })).map(x => x.text).join('')
    expect(shown).toContain('git feature 1 ahead')
    expect(shown).toContain('Add the thing')
    expect(shown).toContain('+ commit')
    await ui.unmount()
  }
})
