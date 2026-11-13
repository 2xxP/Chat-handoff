import type { ModelForkResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'chat-handoff',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// The band is drawn on these three; the other surfaces have none.
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const NOTE = '# Handoff: Tests\n\n## Goal\nShip it.\n\n## Next steps\n1. Run it.'

const ANSWER: ModelForkResult = { isAnswered: true, text: NOTE, usage: USAGE }

type World = {
  statuses: (string | undefined)[]
  toasts: string[]
  files: { path: string; text: string }[]
  asked: string[]
  placed: string[]
  unanswered: number
}

// Nothing sits beneath the mod: each hook here stands for the engine. A call
// on `$` is answered `{ value }`; an event by its own result.
const world = (
  on: On,
  reply: ModelForkResult | (() => ModelForkResult) = ANSWER,
  isDiskRefusing = false,
): World => {
  const seen: World = {
    statuses: [],
    toasts: [],
    files: [],
    asked: [],
    placed: [],
    unanswered: 0,
  }

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('model.fork', (_, e) => {
    seen.asked.push(e.prompt)

    return { value: typeof reply === 'function' ? reply() : reply }
  })
  on('fs.write', (_, e) => {
    if (isDiskRefusing) {
      throw new Error('EACCES')
    }

    seen.files.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('ui.place', (_, e) => {
    seen.placed.push(e.id)

    return { value: { isPlaced: true, requestId: e.id } }
  })
  on('ui.copy', () => ({
    value: { isCopied: false, reason: 'no-clipboard' },
  }))
  // Reached only if the mod's own /handoff hook did not answer.
  on('command.run', () => {
    seen.unanswered += 1

    return { text: 'no hook answered' }
  })

  return seen
}

const begin = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

const measure = ($: Engine, percent: number) =>
  $.session.measure({
    context: { window: 200000, tokens: percent * 2000, percent },
    rateLimits: [],
    changed: ['context'],
  })

// The row a button or the automatic setting placed in the conversation.
const placedRow = ($: Engine, id: string) =>
  $.ui.mount({
    plugin: 'chat-handoff',
    component: 'Placed',
    surface: 'mobile',
    requestId: id,
    props: { id, plugin: 'chat-handoff' },
  })

const handoff = ($: Engine, args = '') =>
  $.command.run({
    command: 'handoff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('a short chat shows its length and no warning', async ($, on) => {
  mock.clock(on)
  const seen = world(on)

  await begin($)
  await measure($, 42)

  expect(seen.statuses.at(-1)).toBe('Chat 42% full')
  expect(seen.toasts).toHaveLength(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.keepsBeneath()).toBe(true)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  }
})

test('the warning comes once per step, and Later holds it until the next', async ($, on) => {
  mock.clock(on)
  const seen = world(on)

  await begin($)
  await measure($, 61)

  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/61% full.*\/handoff/)
  expect(seen.statuses.at(-1)).toMatch(/^Chat 61% full · \/handoff/)

  await measure($, 65)
  expect(seen.toasts).toHaveLength(1)

  await measure($, 72)
  expect(seen.toasts).toHaveLength(2)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /72% full/ })).toBeDefined()
    expect(await ui.find({ key: 'write' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'later' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

  // Still within the step that was answered: quiet.
  await measure($, 78)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

  // The next step: the warning is back.
  await measure($, 81)
  expect(seen.toasts).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: /81% full/ })).toBeDefined()
  await ui.unmount()
})

test('/handoff writes the note, saves it and shows it', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  const seen = world(on)

  await begin($)
  await measure($, 64)

  const ran = await handoff($)

  expect(seen.unanswered).toBe(0)
  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toContain('## Tried and ruled out')
  expect(seen.asked[0]).toContain('Never include passwords')

  expect(seen.files).toHaveLength(1)
  // The engine resolves the folder against the working directory.
  expect(seen.files[0]?.path).toMatch(
    /\/handoffs\/handoff-\d{4}-\d{2}-\d{2}-\d{4}\.md$/,
  )
  expect(seen.files[0]?.text).toBe(`${NOTE}\n`)

  expect(ran.text).toContain(NOTE)
  expect(ran.text).toMatch(/Saved to `handoffs\/handoff-[\d-]+\.md`/)
  // Typed, the note is the command's own output: no separate row.
  expect(seen.placed).toHaveLength(0)
  expect(seen.toasts.at(-1)).toMatch(/^Handoff note saved to handoffs\//)
  expect(seen.statuses.at(-1)).toMatch(/^Chat 64% full/)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(
      await ui.find({ type: 'Text', text: /Handoff note ready/ }),
    ).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'copy' })
  expect(seen.toasts.at(-1)).toMatch(/Copying is not available here/)

  // Hidden, and the warning it answered stays quiet too.
  await ui.press({ key: 'hide' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('words and a code fence around the note are left off', async ($, on) => {
  mock.clock(on)
  const seen = world(on, {
    isAnswered: true,
    text: `Here is your note:\n\n\`\`\`markdown\n${NOTE}\n\`\`\`\n\nGood luck!`,
    usage: USAGE,
  })

  await begin($)
  await handoff($)

  expect(seen.files[0]?.text).toBe(`${NOTE}\n`)
})

test(
  'what is typed after /handoff, and the always-include list, reach the model',
  { options: { alwaysInclude: 'the budget, who to email' } },
  async ($, on) => {
    mock.clock(on)
    const seen = world(on)

    await begin($)
    await handoff($, '  the login bug ')

    expect(seen.asked[0]).toContain('- the budget\n- who to email')
    expect(seen.asked[0]).toContain('particular weight to: the login bug')
  },
)

test(
  'with no folder set the note stays in the chat',
  { options: { saveFolder: '' } },
  async ($, on) => {
    mock.clock(on)
    const seen = world(on)

    await begin($)
    const ran = await handoff($)

    expect(seen.files).toHaveLength(0)
    expect(ran.text).toContain(NOTE)
    expect(ran.text).not.toContain('Saved to')
  },
)

test('a note that cannot be written says why and offers another try', async ($, on) => {
  mock.clock(on)
  const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })

  await begin($)
  const ran = await handoff($)

  expect(ran.text).toMatch(/Could not write the handoff note: there is nothing/)
  expect(seen.files).toHaveLength(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'mobile' })

  expect(await ui.find({ key: 'retry' })).toBeDefined()
  await ui.unmount()
})

test("the band's button writes the note and shows it in the chat", async ($, on) => {
  mock.clock(on)
  const seen = world(on)

  await begin($)
  await measure($, 61)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'write' })

  expect(seen.files).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Handoff note ready/ })).toBeDefined()
  await ui.unmount()

  expect(seen.placed).toHaveLength(1)

  const row = await placedRow($, seen.placed[0] ?? '')
  const drawn = await row.find({ type: 'Markdown' })

  expect(drawn?.text).toContain(NOTE)
  expect(drawn?.text).toMatch(/Saved to `handoffs\//)
  await row.unmount()
})

test('a failed try from the button is said, and Try again writes it', async ($, on) => {
  mock.clock(on)
  // The model is out for the first try.
  let isDown = true
  const seen = world(on, () =>
    isDown ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : ANSWER,
  )

  await begin($)
  await measure($, 61)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'write' })
  expect(seen.toasts.at(-1)).toMatch(/Could not write the handoff note/)
  expect(seen.placed).toHaveLength(0)

  isDown = false
  await ui.press({ key: 'retry' })
  expect(seen.files).toHaveLength(1)
  expect(seen.placed).toHaveLength(1)
  await ui.unmount()
})

test(
  'set to write, the note is written at the warning point without asking',
  { options: { whenReached: 'write' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const seen = world(on)

    await begin($)
    await measure($, 61)

    expect(seen.toasts[0]).toMatch(/61% full\. Writing a handoff note/)
    expect(seen.files).toHaveLength(0)

    await clock.advance(250)

    expect(seen.files).toHaveLength(1)
    expect(seen.placed).toHaveLength(1)

    const row = await placedRow($, seen.placed[0] ?? '')

    expect((await row.find({ type: 'Markdown' }))?.text).toContain(NOTE)
    await row.unmount()

    // Later steps warn; they do not write again unasked.
    await measure($, 72)
    await clock.advance(250)
    expect(seen.files).toHaveLength(1)
    expect(seen.toasts.at(-1)).toMatch(/72% full\. Run \/handoff/)
  },
)

test(
  'the warning point is a setting',
  { options: { warnAtPercent: 30 } },
  async ($, on) => {
    mock.clock(on)
    const seen = world(on)

    await begin($)
    await measure($, 29)
    expect(seen.toasts).toHaveLength(0)

    await measure($, 30)
    expect(seen.toasts).toHaveLength(1)
  },
)

test('a compaction or a /clear takes the warning down', async ($, on) => {
  mock.clock(on)
  const seen = world(on)

  await begin($)
  await measure($, 85)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ key: 'write' })).toBeDefined()

  // The reading after a compaction has no fill until the next reply.
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'hello', toolUses: [] }],
  })
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

  await measure($, 85)
  expect(await ui.find({ key: 'write' })).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('a save that fails still gives the note, and says it was not saved', async ($, on) => {
  mock.clock(on)
  const seen = world(on, ANSWER, true)

  await begin($)
  const ran = await handoff($)

  expect(ran.text).toContain(NOTE)
  expect(ran.text).toMatch(/Could not save a copy to `handoffs\//)
  expect(seen.toasts.at(-1)).toBe('Handoff note ready.')
})
