import { buildTextInputMessage } from '../../agent/message-builder.ts'
import type { HandoffContext } from './manager.ts'

export const COMPACT_EVENT_TYPE = 'session.compact'
export const COMPACT_EVENT_SOURCE = 'runtime-context'
export const COMPACT_DRAFT_PATH = 'v:handoff/draft.md'

const MAX_DRAFT_LENGTH = 8_000
// Match the legacy parseHandoffArgs semantic limits without silent truncation.
const MAX_SUMMARY_LENGTH = 4_000
const MAX_OBJECTIVE_LENGTH = 240
const MAX_TRANSCRIPT_ITEMS = 24
const MAX_TRANSCRIPT_ITEM_LENGTH = 240
const SECTION_HEADINGS = ['## Summary', '## Current Objective', '## Recent Transcript'] as const
export function compactEvent(id: string, timestamp: string) {
  return buildTextInputMessage({
    kind: 'message', policy: 'silent', id, timestamp,
    source: { kind: 'event', type: COMPACT_EVENT_TYPE, source: COMPACT_EVENT_SOURCE, eventId: id },
    content: [
      'Internal session maintenance: the current context segment is about to be compacted. This event is not a new user request or permission.',
      'Write a continuation for yourself in the same session. Start with the current conversation. If you need earlier context, read v:sessions to discover the available segment paths; scoped conversations expose only v:sessions/current. Do not resume work or reply to the user.',
      `Use write with path ${COMPACT_DRAFT_PATH} and full Markdown content; no other writes are allowed. Then call invoke_tool({name:"handoff_submit", args:{}}) by itself. If validation fails, replace the draft and submit again. Other tools shown in this request are not executable during compact. Read accepts path and optional positive offset/limit for paging.`,
      'Preserve the current objective, applicable constraints and their sources, decisions and their rationale, corrected premises, durable artifact references, and the next concrete step. Distinguish completed from outstanding work; record in-flight external operations and uncertain outcomes so they are not repeated. Preserve applicable Work keys and revisions without treating history as current authority. Do not copy raw tool output, secrets, or credentials into the handoff.',
      `Use these exact Markdown headings in this order; keep the full draft within ${MAX_DRAFT_LENGTH} characters:`,
      [
        `${SECTION_HEADINGS[0]}\nNonempty summary (up to ${MAX_SUMMARY_LENGTH} characters). Use ### or deeper for subsections.`,
        `${SECTION_HEADINGS[1]}\nNonempty statement of the next objective (up to ${MAX_OBJECTIVE_LENGTH} characters), or state that no action remains.`,
        `${SECTION_HEADINGS[2]}\nOptional; omit if not needed. Use up to ${MAX_TRANSCRIPT_ITEMS} one-line bullets, each starting with "- " and containing at most ${MAX_TRANSCRIPT_ITEM_LENGTH} characters of text.`,
      ].join('\n\n'),
    ].join('\n\n'),
  })
}

/** Ephemeral draft for a single compaction attempt, never a workspace file. */
export class CompactDraft {
  private markdown = ''

  get content(): string {
    return this.markdown
  }

  replace(content: string): void {
    // A failed replacement must not leave the prior draft eligible for submission.
    this.markdown = ''
    if (typeof content !== 'string') {
      throw new Error(`Replace ${COMPACT_DRAFT_PATH} with a Markdown string.`)
    }
    if (content.length > MAX_DRAFT_LENGTH) {
      throw new Error(`Shorten ${COMPACT_DRAFT_PATH} to at most ${MAX_DRAFT_LENGTH} characters and write it again.`)
    }
    this.markdown = content
  }

  finalize(): HandoffContext {
    if (!this.markdown.trim()) {
      throw new Error(`Write a nonempty Markdown draft to ${COMPACT_DRAFT_PATH} before submitting.`)
    }

    const bodies: string[][] = []
    let openFence: string | undefined
    for (const line of this.markdown.split(/\r\n?|\n/)) {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (openFence) {
        if (fence && fence[1].startsWith(openFence) && !fence[2].trim()) openFence = undefined
        bodies[bodies.length - 1].push(line)
        continue
      }
      if (fence && bodies.length) openFence = fence[1]
      const heading = line.trimEnd()
      const expected = SECTION_HEADINGS[bodies.length]
      if (heading === expected) {
        bodies.push([])
      } else if (/^ {0,3}#{1,2}(?:[ \t]|$)/.test(heading)) {
        throw new Error(expected
          ? `Unexpected top-level heading. Use ${expected} next; use ### or deeper for subsections.`
          : `Unexpected top-level heading. Use only ${SECTION_HEADINGS.join(', ')} as section headings.`)
      } else if (bodies.length) {
        bodies[bodies.length - 1].push(line)
      } else if (heading) {
        throw new Error(`Start the draft with ${SECTION_HEADINGS[0]}; do not include a preamble or wrap the draft in a code fence.`)
      }
    }

    if (openFence) throw new Error('Close the Markdown code fence or remove it before submitting.')

    const [summary, currentObjective] = [MAX_SUMMARY_LENGTH, MAX_OBJECTIVE_LENGTH].map((limit, index) => {
      const body = bodies[index]?.join('\n').trim()
      if (!body) throw new Error(`Add a nonempty ${SECTION_HEADINGS[index]} section before submitting.`)
      if (body.length > limit) throw new Error(`Shorten ${SECTION_HEADINGS[index]} to at most ${limit} characters.`)
      return body
    })

    const recentTranscript = (bodies[2] ?? []).filter(line => line.trim()).map(line => {
      const item = line.match(/^[-*+][ \t]+(.+)$/)?.[1].trim()
      if (!item) throw new Error(`Use a one-line Markdown bullet starting with "- " for each entry in ${SECTION_HEADINGS[2]}.`)
      if (item.length > MAX_TRANSCRIPT_ITEM_LENGTH) {
        throw new Error(`Shorten each ${SECTION_HEADINGS[2]} bullet to at most ${MAX_TRANSCRIPT_ITEM_LENGTH} characters.`)
      }
      return item
    })
    if (bodies[2] && !recentTranscript.length) {
      throw new Error(`Add a bullet to ${SECTION_HEADINGS[2]} or omit the optional section.`)
    }
    if (recentTranscript.length > MAX_TRANSCRIPT_ITEMS) {
      throw new Error(`Keep at most ${MAX_TRANSCRIPT_ITEMS} bullets in ${SECTION_HEADINGS[2]}.`)
    }
    return { summary, currentObjective, recentTranscript }
  }
}
