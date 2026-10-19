export type Op = 'view' | 'edit' | 'create' | 'delete'

/** One path of the scanned project, relative to the session's directory. */
export type TreeEntry = { p: string; d: boolean; m: number }

/** What Claude last did to a path, and when (ms since the epoch). */
export type Activity = {
  op: Op
  startedAt: number
  /** Absent while the operation runs. */
  endedAt?: number
  /** Tool calls currently running on the path. */
  running: number
}

/** A deleted path kept on screen while its exit plays. */
export type Ghost = { d: boolean; at: number }

export type TurnInfo = {
  phase: 'idle' | 'working' | 'complete'
  at: number
  counts: Record<Op, string[]>
}

/** One Edit or Write replayed in the code view: a window of the file before and after. */
export type Clip = {
  path: string
  /** When the replay starts (ms since the epoch). */
  at: number
  /** How long the replay runs. */
  dur: number
  /** Line number of the window's first line. */
  first: number
  before: string[]
  after: string[]
  /** Lines of the new text left out of the window. */
  more: number
  adds: number
  dels: number
  /** The whole file after the edit, for scrolling through it. */
  file: string[]
  /** Line numbers (from 1) the edit added or changed. */
  changed: number[]
}

/** The thinking block streaming now, or the last one, as one line of text. */
export type Thought = {
  /** Which block this is: a new key starts the typewriter over. */
  key: string
  /** Whitespace collapsed to single spaces; only the tail is kept. */
  text: string
  /** Characters cut from the front of `text` to keep it short. */
  dropped: number
  /** When the last piece arrived. */
  at: number
  /** Absent while the block is still streaming. */
  endedAt?: number
  /** When the model request now streaming began, while no words of its thinking have come. */
  waitingSince?: number
}

export type GitKind = 'checkout' | 'branch' | 'commit' | 'merge' | 'rebase' | 'push' | 'pull' | 'fetch' | 'reset' | 'pr' | 'pr-merge'

/** One git or gh command Claude ran, as the git view shows it. */
export type GitAction = { kind: GitKind; ref?: string }

/** One row of `git log --graph`: the graph cells, and the commit on it if any. */
export type GitRow = { graph: string; hash?: string; refs?: string[]; subject?: string; isHead?: boolean }

/** The git view: the graph read after Claude's last git command, and what that command did. */
export type GitState = {
  rows: GitRow[]
  /** The checked-out branch, or the short hash when detached. */
  head: string
  /** Commits ahead of and behind the upstream branch, when there is one. */
  ahead?: number
  behind?: number
  /** Branches beside HEAD worth drawing: the last ones a command named. */
  refs: string[]
  /** Commits that weren't in the graph before the last command: they pop in. */
  fresh: string[]
  action?: GitAction
  /** When the last command started, ended, and whether it failed. */
  at: number
  endedAt?: number
  isFailed?: boolean
  pr?: { number: number; head: string; base?: string; state: 'open' | 'merged'; at: number }
}

declare module 'claude-code' {
  interface PluginState {
    'work-visualized': {
      tree: TreeEntry[]
      activity: Record<string, Activity>
      ghosts: Record<string, Ghost>
      turn: TurnInfo
      watching: boolean
      clips: Clip[]
      git: GitState | null
      thought: Thought | null
    }
  }
}
