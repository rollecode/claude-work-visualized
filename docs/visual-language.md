# Visual language

Every glyph is a single terminal cell, so the tree's columns never move, whatever is animating.
Animations use smoothstep curves and continuous colour mixing rather than on/off flashes. The pane
redraws at about 30 fps while anything moves.

## Operations

| Op | Glyph | Colour | Bright | Row tint |
| --- | --- | --- | --- | --- |
| read | `◉` | `#58a6ff` | `#cfe6ff` | `#0c2d4f` |
| edit | `±` | `#f0883e` | `#ffe2c4` | `#3d2410` |
| create | `+` | `#3fb950` | `#d2f8dc` | `#0f3a1e` |
| delete | `✗` | `#f85149` | `#ffd7d5` | `#4a1316` |

Other colours: Claude's accent `#d97757` (the spark and prompt), text `#c9d1d9`, muted `#6e7681`,
folders `#8b98a5`, guides `#30363d`.

## The current file

Only one file at a time gets the strongest animation: the most recently started operation that's
still running. Its row gets:

- `▌` in the gutter, gently pulsing
- the op's tint behind the row
- its op animation (below)
- a dotted leader `╌╌╌` flowing from the right edge toward the file, ending in `◂ reading` with a
  shine sweeping across the word

Other operations running at the same time get only their glyph and a slow, quiet pulse.

### Running animations

- **read:** a band of light about 2.6 cells wide sweeps back and forth across the name every
  1.4 s, brightening the text and lighting the cells behind it blue.
- **edit:** a ripple runs along the name, each letter about 55 ms after the one before, like
  keystrokes landing. A cursor `▏` blinks after the name.
- **create:** for the first 700 ms the name types itself in with a bright leading edge, while the
  glyph grows `· → ∙ → • → +`. After that the name shimmers on a softly glowing green background.
- **delete:** the glyph and name pulse between their colour and bright red every 760 ms.

## Fading back to normal

After an operation ends, the file fades back step by step. Each step starts at the colour the
previous one ended with, so there's no visible jump.

| Stage | Time after the operation | Looks like |
| --- | --- | --- |
| done | 0 to 1.8 s | `✓` and name fade from bright to the op colour |
| recent | 1.8 to 20 s | the op glyph remains; the name fades from the op colour toward plain text |
| trail | 20 to 60 s | a faint `✓` fades out |
| normal | after 60 s | `·` and plain text |

## Deletion

A deleted file stays in the tree for 2.3 s, so you can see what happened:

| Time | Phase |
| --- | --- |
| 0 to 450 ms | Red highlight builds up behind the name |
| 450 to 1,050 ms | Damped shake: up to 3 cells of jolt, settling to still while the red softens |
| 1,050 to 2,300 ms | Dissolve: letters disappear from the right, each dimming before it goes, struck through |

A deleted folder shows as a single fading row instead of one row per file inside it.

## The path down the tree

- Tree guides (`├╴ └╴ │`) on the path down to the current file are drawn in its op colour, with a
  pulse flowing down from the top level.
- Parent folders on the path show `●`, `•` or `·`, getting smaller and dimmer the further up they
  are.
- Any other folder with recent activity below it shows a faint `·` and is coloured by that
  activity.
- A closed folder shows how many children it has, e.g. `+3`.

## Git graph

When Claude runs a `git` or `gh` command that moves branches or commits, a `── git <branch> ──`
section opens under the thinking section with the branch graph from `git log --graph`: HEAD, plus
up to 3 branches the last commands named, 8 commits at most, 30 % of the pane's height (4 to 12
rows). The rule also says how far HEAD is from its upstream, e.g. `git main 2 ahead`.

| Action | Glyph | Colour | On the graph |
| --- | --- | --- | --- |
| checkout, switch | `→` | blue | the `◉` HEAD marker moves to the branch |
| branch | `+` | green | the branch appears beside HEAD |
| commit, cherry-pick, revert | `+` | green | the new commit's dot grows `· ∙ • ●` over 0.7 s |
| merge, `gh pr merge` | `◆` | purple | the graph's lines near HEAD pulse for 3 s |
| rebase | `◆` | orange | the same |
| push | `↑` | orange | ahead and behind are counted again |
| pull, fetch | `↓` | blue | the same |
| reset | `←` | red | HEAD moves |
| `gh pr create` | `#` | green | a rounded PR card under the graph for 20 s: `#4 open`, `head → base`; then only the rule names it, `git main · #4 open`. `/prs` hides PRs |

While the command runs, the prompt line says what it does, shimmering in the action's colour (`❯ committing Add notes 0.4s █`, `❯ merging feature`, `❯ pushing origin`), and the HEAD row ends in `◂` and the action's name. A commit's message waits above HEAD as a green `○` row until the commit lands; the new commit's subject then stays green, fading over 20 s. A command run in another repository (`cd ../other && git …`, `git -C`) shows that repository, named in the rule; afterwards the
label stays and fades to muted over 20 s, or shows `✗` in red if the command failed. The section
stays a minute after the last git command, then fades over 1.5 s.

## Chrome

- **Header:** `✶ work-map ~/project`. The spark turns through `· ∙ • ◆ ✶` while Claude works.
- **Prompt line:**
  - working: `❯ editing src/app.ts 2.4s █`. The verb shimmers, the folder is muted, and the timer
    counts up.
  - thinking: `❯ thinking █`
  - idle: `❯ idle · N files █`
  - The block cursor always blinks.
- **Thinking:** while Claude thinks, a `── thinking ──` section under the prompt line types the
  thought out at a reading pace of 35 characters a second. It only speeds up once it is more than
  400 characters behind the stream, or to 3 times the pace once the thought has ended. Until the
  first words arrive, from the moment a model request starts, the section shows a wave of dots
  `• • • • •` and the prompt line counts the seconds, `❯ thinking 4s █`. The word is shown once:
  while the prompt line says thinking the section has no title (only `↑N` / `↓N` when scrolled),
  and while Claude does something else the section is titled `── thinking ──`. A request that turns out not to think puts the last
  thought back. Whitespace is collapsed, older lines are dimmer and the newest
  letters bright at a blinking `▏` cursor. The section is 30 % of the pane's height, 4 to 12 lines,
  with `↑N` / `↓N` for lines out of view. The wheel over the section scrolls the
  thought; it stays where you left it for 20 s, or until you scroll back to the end. Each new
  thinking block in a turn goes on as a new paragraph under the last, and the dots that wait for
  the next one sit under what was thought so far, so nothing is taken away mid-turn: the whole
  turn's thinking (the last 24,000 characters) can be scrolled back through. It stays for the
  whole turn and 20 s after it, then fades over 1.5 s. A new turn starts it over.
- **Section rules:** `── tree ──` (with `↑N` when scrolled) and `── legend ──`.
- **Completion card:** a rounded box whose border fades in. `✓ TASK COMPLETE` appears letter by
  letter, then one row per operation slides in about 120 ms apart, its count and `━━━` bar
  growing. It fades out over the last 1.5 s of its 20 s.
