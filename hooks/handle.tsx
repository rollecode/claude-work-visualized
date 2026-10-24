import type { ClientModule, JsonValue } from 'claude-code'

/** A divider the person drags: `x` between the tree and the side column, `y` a section's rule. */
type HandleProps = {
  axis: 'x' | 'y'
  /** The size the handle sets, as drawn now: the tree's columns, or the section's rows. */
  at: number
  /** -1 when the section is below the rule, so dragging down shrinks it. */
  dir?: 1 | -1
  rows: number
  /** The rule a `y` handle draws. */
  segs: { t: string; c?: string; b?: boolean }[]
  /** The colour the rule's faint parts take while the pointer is on it. */
  hot: string
  faint: string
}

type HandleState = { grab?: number; isOver?: boolean }

// Posts `{ to }`, the size under the pointer, on every move of a drag, and `done` when the button comes up.
const Handle: ClientModule<JsonValue, HandleState> = (raw, surface) => {
  const p = raw as unknown as HandleProps
  const { Box, Text } = surface.elements

  surface.onPointer(e => {
    const st = surface.state ?? {}
    const pos = p.axis === 'x' ? e.x : e.y
    if (e.type === 'down' && e.button === 'left') {
      surface.setState({ ...st, grab: pos })
      return
    }
    if (e.type === 'enter' || e.type === 'leave') {
      surface.setState({ ...st, isOver: e.type === 'enter' })
      return
    }
    if (st.grab === undefined) {
      return
    }
    if (e.type === 'move' && e.button !== undefined) {
      surface.post({ to: p.at + (p.dir ?? 1) * (pos - st.grab) })
      return
    }
    if (e.type === 'up') {
      surface.post({ to: p.at + (p.dir ?? 1) * (pos - st.grab), done: true })
      surface.setState({ isOver: e.x >= 0 && e.x < surface.columns && e.y >= 0 && e.y < surface.rows })
    }
  })

  const st = surface.state ?? {}
  const isHot = st.isOver === true || st.grab !== undefined
  if (p.axis === 'x') {
    return (
      <Box flexDirection="column" width={2}>
        {Array.from({ length: p.rows }, (_, i) => (
          <Text key={`d${i}`} color={isHot ? p.hot : p.faint}>{'│ '}</Text>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" height={1}>
      {p.segs.map((s, i) => (
        <Text key={`s${i}`} color={isHot && s.c === p.faint ? p.hot : s.c} bold={s.b} wrap="truncate">
          {s.t}
        </Text>
      ))}
    </Box>
  )
}

export default Handle
