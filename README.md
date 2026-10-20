# Claude Work Visualized

[![Version](https://img.shields.io/github/v/release/rollecode/claude-work-visualized?style=for-the-badge&color=6364FF&label=version)](https://github.com/rollecode/claude-work-visualized/releases)
[![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![TypeScript](https://img.shields.io/badge/typescript-%233178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](hooks/)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950.svg?style=for-the-badge)](LICENSE)

A Claude Code plugin that adds a live, animated map of your project next to the chat. Every file Claude reads, edits, creates or deletes lights up in the tree as it happens, and every edit is replayed as keystrokes in a code view beside it.

<p align="center">
  <img src="docs/media/session.gif" alt="Claude Code on the left and the work pane on the right: Claude's thinking types itself out, a branch is checked out on the git graph, the tree lights up as Claude reads, edits, creates and deletes files while the code view types each change in, then the commit lands green on the graph, the branch is pushed and a pull request card opens" width="100%">
</p>

This is Rolle's fork of [GrzeskoByte/claude-work-visualized](https://github.com/GrzeskoByte/claude-work-visualized). It adds the code view, syntax highlighting, one-line edit results in the chat, remote work over `ssh`, `scp` and `rsync`, and replays of files changed by shell commands. See the [changelog](CHANGELOG.md).

## Quick install via Claude Code

Paste this into Claude Code and let it do the installing:

```
Install the Claude Code plugin from https://github.com/rollecode/claude-work-visualized. Run `claude plugin marketplace add rollecode/claude-work-visualized` and then `claude plugin install work-visualized@claude-work-visualized`. In ~/.claude/settings.json, set "verbose": false, "bashEditDiffEnabled": false and "showThinkingSummaries": true (the pane shows diffs and thinking itself, so the chat can stay short). Tell me to restart Claude Code and, if the pane doesn't open by itself, to run /watch.
```

## Features

- **Live file tree.** The project is scanned at session start and rescanned every 1.5 seconds, so changes from scripts, builds and your editor show up too.
- **A look per operation.** Read, edit, create and delete each have their own colour, glyph and animation.
- **Current file.** The file Claude is on gets the strongest animation, a `▌` marker and a `◂ editing` label, and the path down to it lights up.
- **Fading trail.** Touched files stay marked and fade back to normal over about a minute.
- **Prompt line.** Shows what Claude is doing, on which path and for how long. A call that touches no file (`df -h`, a test run, a web search, an MCP tool) shows as `running …` while it runs.
- **Progress.** A running copy or download (`cp`, `rsync`, `scp`, `dd`, `curl -o`, `wget -O`, a `>` redirect) shows how far it has got: a percentage and a filling bar when the source size is known, otherwise the bytes landed so far.
- **Searches and globs.** Files a command's output lists (`grep -rl`, `find`, `ls`) flash as read, and a glob (`wc -l src/*.ts`, `sed -i … *.md`) lights each file it matches.
- **Code view.** Each `Edit` and `Write`, and each file a shell command changes (`sed -i`, `>`, `tee`, a script that rewrites a file it names), is replayed as keystrokes: replaced lines turn red and fold away, new lines type in behind a caret, and gutter marks stay for a while. Highlighting covers about 60 languages through Prism, in Tokyo Night colours.
- **Quiet chat.** While the pane is shown, an edit's result in the chat is one line (`± Edited src/app.ts +3 -1`), because the pane already shows the diff.
- **Remote work.** Files touched over `ssh`, `scp` and `rsync` show under a folder per host (`deploy@web1:/etc/nginx/…`), and the header names the host Claude is working on.
- **Live thinking.** Claude's thinking types itself out under the prompt line at a pace you can read (a wave of dots and a seconds count hold its place until the words arrive), with a blinking cursor, in up to 12 lines. Each new thought goes on under the last, and nothing is taken away until the turn ends, so scroll over it to read back through the whole turn's thinking. It stays until 20 seconds after the turn ends. Needs `"showThinkingSummaries": true` in `~/.claude/settings.json`: without it Claude Code receives thinking with no text.
- **Git graph.** When Claude runs `git` or `gh`, a small branch graph appears under the prompt line: checkouts move the `◉` HEAD marker, new commits pop in, merges light up the joining lines, pushes and pulls count commits ahead and behind, the prompt line names the action as it runs (`❯ committing Add notes 0.4s`) with the commit's message waiting green above HEAD, and `gh pr create` / `gh pr merge` show a PR card for 20 seconds, then just `#7 open` in the graph's title (`/prs` hides them). It stays for a minute after the last git command.
- **Completion card.** When a turn ends, a card counts the files viewed, edited, created and deleted.
- **Terminal friendly.** One-cell glyphs and box-drawing characters only, up to 30 fps while something moves, idle otherwise.

## Installation

Requires [Claude Code](https://claude.com/claude-code) with function-hooks plugins, tested on 2.1.288 and later. The function-hooks API is in early access and may change between releases. The pane opens by itself in a terminal at least 144 columns wide, and the colours are tuned for a dark theme.

### From the marketplace

This repository is also a plugin marketplace:

```sh
claude plugin marketplace add rollecode/claude-work-visualized
claude plugin install work-visualized@claude-work-visualized
```

The same works inside Claude Code as `/plugin marketplace add …` and `/plugin install …`. Start a new session and the work map loads.

Update and remove with:

```sh
claude plugin marketplace update claude-work-visualized
claude plugin update work-visualized@claude-work-visualized
claude plugin uninstall work-visualized@claude-work-visualized
```

### From a local clone

```sh
git clone https://github.com/rollecode/claude-work-visualized.git
claude --plugin-dir ./claude-work-visualized
```

`--plugin-dir` loads the plugin for one session and reloads it on every save. To load it in every session, put the folder's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/claude-work-visualized"
  }
}
```

### Recommended Claude Code settings

The pane works best when the chat stays short. The GIF above runs with these in `~/.claude/settings.json`:

```json
{
  "verbose": false,
  "bashEditDiffEnabled": false
}
```

`verbose: false` keeps tool output collapsed to one line (`Ctrl+O` still opens the full transcript), and `bashEditDiffEnabled: false` stops Claude Code from printing a diff after each shell command that changes files. Claude Code turns that diff on by default in auto mode.

## Usage

| Command | What it does |
| --- | --- |
| `/watch` | Opens or closes the pane. The choice is remembered across sessions. |
| `/diffs` | Switches edit results in the chat between one line and the full diff. Also remembered. |
| `/prs` | Shows or hides pull requests in the git graph. The choice is remembered across sessions. |

- Closing the pane by hand also turns watching off, and the next `/watch` reopens it.
- While a tool runs, the status line shows the current operation, for example `± edit src/app.ts`.
- Scroll over the code view (mouse wheel, touchpad, or the arrow and page keys with the pane focused) to move through the whole edited file. Claude's next edit brings the view back to following it.

If nothing appears, start Claude Code with `claude --debug`. The debug log names the plugin and the reason whenever a hook fails or the module does not load.

## Visual language

| Glyph | Operation | Colour | While running | After |
| --- | --- | --- | --- | --- |
| `◉` | read | blue | a band of light sweeps across the name | `✓`, colour fades |
| `±` | edit | orange | a ripple runs along the name, then a blinking cursor `▏` | `✓`, colour fades |
| `+` | create | green | the name types itself in, then glows | settles into the tree |
| `✗` | delete | red | red pulse | highlight, damped shake, removed letter by letter |

<table>
  <tr>
    <td align="center"><img src="docs/media/read.png" alt="Reading: a band of light sweeps across session.ts" width="300"><br><sub><b>Reading</b>: the scan band sweeps the name</sub></td>
    <td align="center"><img src="docs/media/edit.png" alt="Editing: session.ts pulses orange, with the lit path from src/ down to it" width="300"><br><sub><b>Editing</b>: ripple, cursor and lit path</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/media/create.png" alt="Creating: UserProfile.tsx types itself into the tree" width="300"><br><sub><b>Creating</b>: the name types itself in</sub></td>
    <td align="center"><img src="docs/media/delete.png" alt="Deleting: legacy.ts flashes red before it leaves the tree" width="300"><br><sub><b>Deleting</b>: red pulse, then shake and dissolve</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/media/complete.png" alt="The completion card: 3 viewed, 2 edited, 1 created, 1 deleted, with bars" width="300"><br><sub><b>Task complete</b>: the trail of the turn and its summary</sub></td>
  </tr>
</table>

<sub>All media is rendered from the plugin's own drawing code, so the pane in it is exactly what the plugin draws. [`scripts/render-session.mjs`](scripts/render-session.mjs) makes the GIF at the top, with the chat column as a mockup of Claude Code, and [`scripts/render-media.mjs`](scripts/render-media.mjs) makes the stills.</sub>

The full timelines and colours are in [docs/visual-language.md](docs/visual-language.md).

## Limitations

- **Shell commands.** Files touched by `rm`, `mv`, `cp`, `touch`, `mkdir`, `sed -i`, `>` and similar are recognised from the command text, and any other command reads the existing files it names. A change no command names is caught by the rescan after it and shown as finished, without a running phase.
- **Other folders.** Files outside the session folder show under `~:/` (your home folder), `scratchpad:/` (Claude Code's scratch folder for the session) or `local:/`. Shell commands are followed through `cd` and `NAME=value`.
- **Remote work.** Only what the command text names is shown. Remote folders are not scanned, so a change a remote script makes on its own is not seen.
- **Changes made outside Claude** animate too, but the completion card counts only what Claude's own tool calls changed.
- **Skipped folders.** `node_modules`, `.git`, `dist`, `build`, caches and virtual environments are left out of the tree.
- **Code view.** A shell command's change is replayed only for files the command names, up to 4 per command. Files over 256 KB are skipped, and one replay shows at most 80 lines.
- **Size.** A scan covers at most 2,000 entries, 12 levels deep.

## Documentation

- [Architecture](docs/architecture.md): how tool calls become animations
- [Visual language](docs/visual-language.md): glyphs, colours and every timeline
- [Development](docs/development.md): project layout, testing, type-checking and changing the plugin

## License

[MIT](LICENSE). Original plugin © 2026 Grzegorz Sierocki, fork changes by Rolle Laukkarinen.
