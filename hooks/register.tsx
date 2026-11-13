import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelForkResult,
  PluginOptions,
  Register,
  SessionContextUsage,
} from 'claude-code'

import type { Job } from '../types'

import { buildPrompt, cleanNote, stamp } from './note'

const IDLE: Job = {
  phase: 'idle',
  isHidden: false,
  path: null,
  note: null,
  at: 0,
}

// A note still "being written" after this long was cut off (a reload, a lost
// connection), so the next /handoff starts over instead of waiting for it.
const STALE_MS = 5 * 60 * 1000

// Change a tag when the fields of its value change: it declines what an
// earlier version of this mod stored, which outlives a reload.
const fill = atom(
  { plugin: 'chat-handoff', key: 'fill' } as const,
  { percent: null, tokens: null, window: null },
  { shape: 'fill-1' },
)
const alert = atom(
  { plugin: 'chat-handoff', key: 'alert' } as const,
  { step: null, hiddenStep: null },
  { shape: 'alert-1' },
)
const job = atom({ plugin: 'chat-handoff', key: 'job' } as const, IDLE, {
  shape: 'job-1',
})
const shown = atom({ plugin: 'chat-handoff', key: 'shown' } as const, [], {
  shape: 'shown-1',
})

type Settings = {
  warnAt: number
  isAuto: boolean
  folder: string
  alwaysInclude: string
}

const settingsFrom = (options: PluginOptions): Settings => {
  const asked = Number(options.warnAtPercent ?? 60)

  return {
    warnAt: Number.isFinite(asked)
      ? Math.min(95, Math.max(10, Math.round(asked)))
      : 60,
    isAuto: options.whenReached === 'write',
    folder: String(options.saveFolder ?? 'handoffs')
      .trim()
      .replace(/\/+$/, ''),
    alwaysInclude: String(options.alwaysInclude ?? ''),
  }
}

// The warning repeats every ten points past the first: 60, 70, 80, 90.
const stepFor = (percent: number | null, warnAt: number): number | null =>
  percent === null || percent < warnAt
    ? null
    : warnAt + Math.floor((percent - warnAt) / 10) * 10

const whyNot = (
  reply: Exclude<ModelForkResult, { isAnswered: true }>,
  isNearlyFull: boolean,
): string => {
  if (reply.reason === 'nothing-to-fork') {
    return 'there is nothing to hand off yet. Try again after the next reply.'
  }

  if (reply.reason === 'aborted') {
    return 'it was interrupted before the note was finished.'
  }

  if (reply.reason === 'empty-reply') {
    return 'the model sent back an empty note.'
  }

  const error =
    reply.status === null
      ? 'the model could not be reached.'
      : `the model returned an error (${reply.status}).`

  return isNearlyFull
    ? `${error} The chat may be too full to summarise: run /compact, then /handoff.`
    : error
}

const showStatus = async (
  $: EngineInterface,
  settings: Settings,
): Promise<void> => {
  const { phase } = await read($, job)
  const { percent } = await read($, fill)

  if (phase === 'writing') {
    $.ui.status('Writing handoff note…')
  } else if (percent === null) {
    $.ui.status(undefined)
  } else if (percent >= settings.warnAt) {
    $.ui.status(`Chat ${percent}% full · /handoff to move to a new chat`)
  } else {
    $.ui.status(`Chat ${percent}% full`)
  }
}

// Takes a new reading of the chat's length: keeps it, moves the warning
// step, and tells the person when the chat has reached a new step.
const track = async (
  $: EngineInterface,
  settings: Settings,
  context: SessionContextUsage,
): Promise<void> => {
  const percent = context.percent ?? null

  await update($, fill, () => ({
    percent,
    tokens: context.tokens ?? null,
    window: context.window,
  }))

  const step = stepFor(percent, settings.warnAt)
  const before = await read($, alert)
  const hasRisen =
    step !== null && (before.step === null || step > before.step)

  if (step !== before.step) {
    await update($, alert, held => ({
      step,
      hiddenStep: step === null ? null : held.hiddenStep,
    }))
  }

  if (hasRisen) {
    // A note written at an earlier step is out of date by now.
    await update($, job, held =>
      held.phase === 'writing' ? held : { ...held, isHidden: true },
    )

    const isFirst = before.step === null

    if (settings.isAuto && isFirst) {
      $.ui.toast(`This chat is ${percent}% full. Writing a handoff note…`, {
        timeoutMs: 8000,
      })
      // From a timer, so this reading is done with before the writing starts.
      $.clock.after(250, () => {
        void produce($, settings)
      })
    } else {
      $.ui.toast(
        `This chat is ${percent}% full. Run /handoff to carry on in a new chat.`,
        { timeoutMs: 10000 },
      )
    }
  }

  await showStatus($, settings)
}

type Written = { isWritten: boolean; text: string; at: number }

// Asks the model for the note over the whole chat (a side question that adds
// nothing to the chat itself), saves a copy, and answers with the text to
// show, or with what went wrong.
const compose = async (
  $: EngineInterface,
  settings: Settings,
  focus: string,
  now: number,
): Promise<Written> => {
  const { date, file } = stamp(now)
  const reply = await $.model
    .fork({
      prompt: buildPrompt({
        date,
        focus,
        alwaysInclude: settings.alwaysInclude,
      }),
    })
    .catch(() => null)

  if (reply === null || !reply.isAnswered) {
    const { percent } = await read($, fill)
    const why =
      reply === null
        ? 'the request could not be sent.'
        : whyNot(reply, (percent ?? 0) >= 90)

    const failed: Job = { ...IDLE, phase: 'failed', note: why, at: now }

    await update($, job, () => failed)
    await showStatus($, settings)

    return {
      isWritten: false,
      text: `Could not write the handoff note: ${why}`,
      at: now,
    }
  }

  const note = cleanNote(reply.text)
  const target =
    settings.folder === '' ? null : `${settings.folder}/handoff-${file}.md`
  let path: string | null = null

  if (target !== null) {
    try {
      await $.fs.write(target, `${note}\n`)
      path = target
    } catch {
      path = null
    }
  }

  const ready: Job = { ...IDLE, phase: 'ready', path, note, at: now }

  await update($, job, () => ready)
  // The warning is answered: stay quiet until the chat reaches the next step.
  await update($, alert, warned => ({ ...warned, hiddenStep: warned.step }))
  await showStatus($, settings)
  $.ui.toast(
    path === null ? 'Handoff note ready.' : `Handoff note saved to ${path}`,
    { timeoutMs: 8000 },
  )

  const how = 'To carry on, start a new chat and paste in the note above'
  const saved =
    path !== null
      ? `Saved to \`${path}\`. ${how}, or attach that file.`
      : target !== null
        ? `Could not save a copy to \`${target}\`, so copy it from here. ${how}.`
        : `${how}.`

  return { isWritten: true, text: `${note}\n\n---\n\n${saved}`, at: now }
}

// Writes the note, one at a time, and never leaves "writing" standing: a
// failure of any kind is kept as the reason and shown with a way to retry.
const write = async (
  $: EngineInterface,
  settings: Settings,
  focus: string,
): Promise<Written> => {
  const now = await $.clock.now()
  const held = await read($, job)

  if (held.phase === 'writing' && now - held.at < STALE_MS) {
    return {
      isWritten: false,
      text: 'A handoff note is already being written.',
      at: now,
    }
  }

  const writing: Job = { ...IDLE, phase: 'writing', at: now }

  await update($, job, () => writing)
  await showStatus($, settings)

  try {
    return await compose($, settings, focus, now)
  } catch (error) {
    const why = 'something went wrong while writing it.'
    const failed: Job = { ...IDLE, phase: 'failed', note: why, at: now }

    $.ui.log(`chat-handoff: writing the note failed: ${String(error)}`, {
      to: 'debug',
    })
    await update($, job, () => failed)
    await showStatus($, settings)

    return {
      isWritten: false,
      text: `Could not write the handoff note: ${why}`,
      at: now,
    }
  }
}

// What a button and the automatic setting run. A mod's own call to its slash
// command does not reach its own hook, so this does the command's work itself
// and puts the note in the conversation as a row of its own.
const produce = async (
  $: EngineInterface,
  settings: Settings,
): Promise<void> => {
  try {
    const written = await write($, settings, '')

    if (!written.isWritten) {
      $.ui.toast(written.text, { timeoutMs: 10000 })

      return
    }

    const id = `note-${written.at}`

    await update($, shown, list =>
      [...list, { id, text: written.text }].slice(-5),
    )
    await $.ui.place({ id })
  } catch {
    $.ui.toast('The handoff note was not written. Type /handoff to try again.')
  }
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff note to carry this chat into a new one',
      argumentHint: '[what to stress]',
    })
    // Whatever was writing a note before this load is gone with it.
    await update($, job, held => (held.phase === 'writing' ? IDLE : held))

    const { context } = await $.session.usage()
    await track($, settings, context)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await track($, settings, e.context)

    return next(e)
  })

  // After a compaction the chat is short again: drop the old reading, so the
  // warning goes and the next reply sets a new one.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)

    if (e.agentId === undefined && e.trigger !== 'precompute') {
      const { context } = await $.session.usage()
      await track($, settings, context)
    }

    return compacted
  }).catch(($, e, next) => next(e))

  // A /clear starts an empty chat. The last note stays, ready to paste there.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, fill, () => ({ percent: null, tokens: null, window: null }))
      await update($, alert, () => ({ step: null, hiddenStep: null }))
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const written = await write($, settings, e.args.trim())

    return { text: written.text }
  })

  // A note a button or the automatic setting wrote, drawn where it was placed.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const row =
      e.props.plugin === 'chat-handoff'
        ? (await read($, shown)).find(one => one.id === e.props.id)
        : undefined

    if (row === undefined) {
      return next(e)
    }

    const { Markdown } = $.ui.resolve(e)

    return <Markdown text={row.text} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const held = await read($, job)
    const warned = await read($, alert)
    const { percent } = await read($, fill)
    const { Box, Button, Text } = $.ui.resolve(e)
    const hide = () => update($, job, last => ({ ...last, isHidden: true }))

    if (held.phase === 'writing') {
      return (
        <Box>
          <Text dimColor>Writing your handoff note…</Text>
        </Box>
      )
    }

    if (held.phase === 'ready' && !held.isHidden && held.note !== null) {
      const note = held.note

      return (
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold>Handoff note ready.</Text>
          <Text dimColor>
            {held.path === null
              ? 'Paste it into a new chat.'
              : `Saved to ${held.path}. Paste it into a new chat.`}
          </Text>
          <Button
            key="copy"
            label="Copy"
            onPress={async press => {
              const copied = await $.ui.copy({
                text: note,
                surface: press.surface,
              })

              $.ui.toast(
                copied.isCopied
                  ? 'Handoff note copied.'
                  : 'Copying is not available here. Select the note in the chat, or open the saved file.',
                { timeoutMs: 8000 },
              )
            }}
          />
          <Button key="hide" label="Hide" onPress={hide} />
        </Box>
      )
    }

    if (held.phase === 'failed' && !held.isHidden) {
      return (
        <Box flexWrap="wrap" columnGap={1}>
          <Text>The handoff note was not written: {held.note}</Text>
          <Button
            key="retry"
            label="Try again"
            variant="primary"
            onPress={() => {
              void produce($, settings)
            }}
          />
          <Button key="hide" label="Hide" onPress={hide} />
        </Box>
      )
    }

    const isWarning =
      warned.step !== null &&
      warned.hiddenStep !== warned.step &&
      percent !== null

    if (!isWarning) {
      return next(e)
    }

    return (
      <Box flexWrap="wrap" columnGap={1}>
        <Text bold>This chat is {percent}% full.</Text>
        <Text dimColor>Long chats get less reliable. Move to a new one?</Text>
        <Button
          key="write"
          label="Write handoff"
          variant="primary"
          onPress={() => {
            void produce($, settings)
          }}
        />
        <Button
          key="later"
          label="Later"
          onPress={() =>
            update($, alert, last => ({ ...last, hiddenStep: last.step }))
          }
        />
      </Box>
    )
  })
}
