# Architecture

The mod is a plugin of function hooks. `hooks/register.tsx` connects it to Claude Code;
`hooks/model.ts` holds all the logic that doesn't touch the engine, so it can be tested with plain
values.

```
 tool.call ──► targetsOf() ──► activity (running) ──► next(e) runs the tool ──► activity (ended)
                                                                              └► rescan() + diff
 every 1.5 s ─────────────────────────────────────────────────────────────────► rescan() + diff
 every 33 ms ──► $.ui.invalidate('ui.render') ──► buildRows(scene at now) ──► Pane
 turn.start / turn.complete ──► turn (phase + counts) ──► completion card
```

## State

Everything the drawing reads lives in `$.state` (declared in `types/index.d.ts`), so it survives a
hot reload:

| Key | Holds |
| --- | --- |
| `tree` | Every scanned path: `{ p, d, m }` (path, is it a folder, last modified time) |
| `activity` | Per path: `{ op, startedAt, endedAt?, running }`, i.e. the last operation and how many tool calls are still running on it |
| `ghosts` | Deleted paths kept on screen while their exit animation plays |
| `turn` | `idle`, `working` or `complete`, plus the paths counted per operation this turn |
| `watching` | Whether `/watch` is on (also kept in `$.store`, so it lasts across sessions) |
| `clips` | Edits queued or shown in the code view: a window of the file before and after |

Drawing-only memory (which folders are open, the scroll position) is kept in module variables.
Losing it on a reload is harmless.

## From tool call to animation

1. **`tool.call` hook.** `targetsOf()` works out which paths the call touches and how:
   - `Read` → view
   - `Edit` / `MultiEdit` / `NotebookEdit` → edit
   - `Write` → edit if the file is already in the tree, otherwise create
   - `Glob` / `Grep` / `LS` → view of the folder searched
   - `Bash` → `classifyBash()` reads the command text (see below)
2. **Before the tool runs**, each target's activity is set to running. A file being created is
   added to the tree right away, so its entrance plays while it's written. The status line names
   the operation.
3. **`next(e)` runs the tool.**
4. **Afterwards**, the activity gets `endedAt`, which starts its fade. If the call failed, edits
   and creates are dropped and paths added in step 2 are removed again. Successful operations are
   counted for the turn.
5. **For any call that can change files**, a rescan is queued. Paths the call named are skipped so
   they aren't counted twice. Deletes always come through the rescan, which turns them into ghosts
   so their exit animation plays.

### Reading shell commands

`classifyBash()` splits a command on `&&`, `||`, `;`, `|` and new lines, handles redirections
(`> file` is an edit, `< file` a view), drops leading `VAR=` assignments and `sudo`, and
recognises:

| Commands | Operation |
| --- | --- |
| `rm`, `unlink`, `rmdir`, `trash`, `shred`, `git rm` | delete |
| `touch`, `mkdir` | create |
| `mv a b`, `git mv a b` | delete `a`, create `b` |
| `cp a b` | view `a`, create `b` |
| `sed -i`, `perl -i`, `tee` | edit |
| `cat`, `head`, `tail`, `less`, `grep`, `rg`, `jq`, `awk`, `wc`, `diff`, … | view |

Only words that name a path already in the tree count (except creates), so a pattern or a flag is
never mistaken for a file.

## Code view

`hooks/code.ts` replays each `Edit`, `MultiEdit` and `Write` in the pane. The line diff and the
replay follow [Code Viz](https://github.com/Waterside-Group/code-viz)'s viewer (MIT).

1. **Before the tool runs**, the `tool.call` hook reads the file (empty for a new one), skipping
   files over 256 KB.
2. **After it succeeds**, the file is read again from disk, so a formatter's changes show too.
   `clipOf()` diffs the two (Myers), keeps a window of up to 80 lines with 3 lines of context
   around the changed regions, and stores it as a clip in `clips`.
3. **Clips queue:** `enqueue()` starts each one when the one before it ends, unless that is more
   than 2.5 s away, in which case it starts at once.
4. **Drawing:** `frameOf()` turns the clip and the time into rows. Each changed region is
   replayed one after another:
   - a few lines changed in the middle are retyped in place: the old part is selected,
     backspaced and the new part typed
   - anything else: the old lines turn red, the new ones are typed below them, then the red rows
     fold away
   Typing speed grows with the size of the edit, so a replay stays within a few seconds.
5. The finished edit stays on screen for 20 s, its gutter marks fading, then the code view goes.

Each frame is highlighted as one text with Prism (`hooks/vendor/prism.js`), so strings and
comments carry across lines; `grammarOf()` picks the grammar from the file name, and `PALETTE`
maps Prism's token kinds to Tokyo Night colours. Long lines wrap onto rows marked `↳`, and the
window eases toward the caret a quarter of the way each frame.

The bundle is built from Prism's own minified files with `_self` set to an empty object: in the
hooks' worker Prism would otherwise answer the engine's messages.

From 96 columns the code view sits beside the tree; narrower, it goes under the tree.

A clip also keeps the whole file after the edit (`file`) and the lines it changed (`changed`). A
`ui.scroll` hook takes the person's wheel, touchpad and scroll keys over the code view:
`browseAfter()` moves a top line through the file (2 lines a tick, 1 a key) and `fileLines()`
draws from there. A scroll over the tree goes on to the engine. Claude's next edit, or 20 s
without scrolling, returns the view to following the replay.

## Scanning and diffing

`scanTree()` lists the project breadth-first through `$.fs.list`, using absolute paths under the
session folder. It skips `IGNORED` folders and stops at 2,000 entries or 12 levels. Scans run one
at a time, in a queue.

`diffTrees(before, after)` sorts every change into one of three kinds:

- **created:** a path that's new
- **edited:** a file whose modification time changed
- **deleted:** a path that's gone, reported only at the highest deleted folder, so `rm -r lib`
  shows one folder fading out instead of every file inside it

Changes the running tool calls didn't account for become finished activity, or ghosts for
deletes. The very first scan only maps the project and never animates anything.

## Drawing

The `ui.render` hook on `{ component: 'Pane', requestId: 'work-map' }` builds the whole pane on
every frame:

1. `buildRows(scene)` turns the tree, the activity, the ghosts and the current time into rows of
   styled cells (`Seg[]`). Nothing in it keeps state except the folder open/closed memory, so each
   frame is a function of time.
2. `scrollTo()` eases the visible window so the current file stays in its upper third.
3. `headerLine()`, `statusLine()`, `summaryLines()` and `legendLines()` draw the rest of the pane.
4. `merge()` joins neighbouring cells that share a style, so a row painted cell by cell still
   becomes only a few `Text` elements.

### The frame clock

`$.clock.every(33)` calls `$.ui.invalidate('ui.render')`, about 30 fps, which is the most the
terminal allows for a shown pane. It does this only while `animateUntil` is in the future. Every
tool call, rescan with changes, or turn event pushes `animateUntil` out to about 62 s. Once a
second the same timer cleans up: it removes finished ghosts and old activity, and stops redrawing
early when nothing is left to animate. While watching is off, the clock does nothing.

### Folder behaviour

- A folder opens when the project has 40 files or fewer, when something under it had activity in
  the last 2 minutes, or when it's at the top level of a small project.
- Its children fade in as it opens and fade out as it closes.
- Each folder's colour comes from the strongest activity below it, weakened by ×0.68 for each
  level up.
