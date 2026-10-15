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

declare module 'claude-code' {
  interface PluginState {
    'work-visualized': {
      tree: TreeEntry[]
      activity: Record<string, Activity>
      ghosts: Record<string, Ghost>
      turn: TurnInfo
      watching: boolean
      clips: Clip[]
    }
  }
}
