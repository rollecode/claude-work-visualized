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

Commands are split outside quotes, and a heredoc's body is kept apart from the commands, so
`ssh host 'a && b'` stays one command and the text a heredoc writes is never read as commands.

### Remote work

- `ssh [options] host command` reads the command as above and marks every path with the host.
  With `bash -s` (or another shell) and a heredoc, the heredoc's lines are the command.
- `scp` and `rsync` read their sources and create their last operand; `host:path` is remote.

`remotePath()` turns a remote path into a tree path under a top folder named after the host:
`web1:/etc/hosts`, or `web1:/~/notes.md` for one under the remote home. Remote paths can't be
checked against a scan, so every one counts. The rescan leaves them in the tree, and a remote
delete becomes a ghost as soon as the command succeeds.

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
