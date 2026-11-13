// What a handoff note contains. This is the file to edit to change what
// carries over into a new chat: the rules, the sections and their order.

export type NoteRequest = {
  /** Today's date, as the note's first line states it. */
  date: string
  /** What the person typed after /handoff, when they want one thing stressed. */
  focus: string
  /** The person's own must-haves, from the mod's settings. */
  alwaysInclude: string
}

const RULES = `Write a handoff note for this conversation. I am going to start a new chat and paste your note in as its first message, so the assistant there can carry on without me explaining everything again. That assistant cannot see this conversation: your note is all it gets.

Rules for the note:
- Write it to the new assistant, as facts and instructions it can act on. Do not retell the back-and-forth.
- Keep it short: aim for 300 to 600 words and never go past 900. Leave out any section that would be empty.
- Be exact where it matters: file paths, commands, links, names, versions, numbers and error messages go in word for word. Quote my own wording for the requirements that matter most.
- Say how sure each thing is. Keep what was actually checked (it ran, it was seen working) apart from what is assumed or untested.
- Give the reason with each decision, in a few words, so it is not reopened.
- Include what was tried and dropped, and why, so it is not tried again.
- Point to files rather than pasting their contents. Include a snippet only if the new chat could not get it any other way.
- Never include passwords, API keys, tokens or other secrets. Say where they are kept instead.
- Say plainly what will not carry over to a new chat: files that only exist in this session, anything still running, attachments I would need to send again, tools or connections that were set up here.
- Do not invent anything. If something is unknown or was never settled, say so.`

const layout = (date: string): string => `Use exactly this layout, in Markdown, in this order:

# Handoff: <a few words naming the work>

Written ${date}. You are picking up work from an earlier chat that got too long. That chat is not available to you: this note is everything you have. Read all of it, tell me in two or three lines what you understand, check anything marked unverified before relying on it, then start on the first next step.

## Goal
What I am trying to achieve and why, in one to three sentences, and what "done" looks like if I said.

## Where things stand
The state right now: what exists, what works (checked), what is half done, what is broken.

## Done and decided
What was finished, and each decision with its reason. Mark the decisions I said are final.

## Tried and ruled out
What failed or was rejected, each with the reason.

## Next steps
A numbered list, most important first. Step 1 must be something the new chat can start on straight away.

## Open questions for me
Anything waiting on my answer or my decision.

## Files, links and references
Each with a few words on what it is and why it matters.

## Rules and preferences
How I want things done: preferences I stated, limits, things I said not to do, the tone or format I asked for, and any standing instructions that applied in this chat.

## Watch out for
Surprises found along the way, and what does not carry over to the new chat.`

const CLOSE = `Reply with the note alone: start at the "# Handoff" line and stop after the last section. No introduction, no closing remarks, no code fence around it.`

const listed = (text: string): string[] =>
  text
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(item => item !== '')

/** The one message the model is asked, over the whole chat so far. */
export const buildPrompt = (request: NoteRequest): string => {
  const extras = listed(request.alwaysInclude)
  const parts = [RULES, layout(request.date)]

  if (extras.length > 0) {
    parts.push(
      `I also want every handoff to cover the following. Put each where it fits best, or in a last section "## Also asked for":\n${extras.map(item => `- ${item}`).join('\n')}`,
    )
  }

  if (request.focus !== '') {
    parts.push(`For this note, give particular weight to: ${request.focus}`)
  }

  parts.push(CLOSE)

  return parts.join('\n\n')
}

const FENCE = /^(`{3,}|~{3,})/

/**
 * The note as the model sent it, less what it was told to leave off: words
 * before the title, and a code fence around the whole with anything after it.
 */
export const cleanNote = (reply: string): string => {
  const lines = reply.trim().split('\n')
  const title = lines.findIndex(line => line.startsWith('# '))

  if (title <= 0) {
    return lines.join('\n')
  }

  const kept = lines.slice(title)
  const isFenced = FENCE.test((lines[title - 1] ?? '').trim())
  const close = isFenced
    ? kept.findLastIndex(line => FENCE.test(line.trim()))
    : -1

  return (close === -1 ? kept : kept.slice(0, close)).join('\n').trim()
}

const two = (value: number): string => String(value).padStart(2, '0')

/** The date for the note's first line, and the same moment as a file name. */
export const stamp = (ms: number): { date: string; file: string } => {
  const at = new Date(ms)
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`

  return { date, file: `${date}-${two(at.getHours())}${two(at.getMinutes())}` }
}
