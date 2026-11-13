/** How full the chat is, as last measured. Null until the first reply. */
export type Fill = {
  percent: number | null
  tokens: number | null
  window: number | null
}

/**
 * The warning. `step` is the warning point the chat has reached (60, 70, 80
 * with the default settings), null while the chat is short. `hiddenStep` is
 * the step the person answered, so the band stays quiet until the next one.
 */
export type Alert = { step: number | null; hiddenStep: number | null }

/** The handoff note being written, or the last one written. */
export type Job = {
  phase: 'idle' | 'writing' | 'ready' | 'failed'
  /** True once the person dismissed the band's row about it. */
  isHidden: boolean
  /** Where the note was saved, relative to the working directory. */
  path: string | null
  /** The note itself when ready; what went wrong when failed. */
  note: string | null
  /** When the phase began, in `$.clock.now()` milliseconds. */
  at: number
}

/**
 * A note a button or the automatic setting wrote, shown in the conversation as
 * a row of its own: the row's id and the text it draws.
 */
export type Shown = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'chat-handoff': {
      fill: Shaped<Fill>
      alert: Shaped<Alert>
      job: Shaped<Job>
      shown: Shaped<Shown[]>
    }
  }
}
