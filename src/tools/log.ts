import { join } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'

/**
 * Tool that appends structured log entries to a JSONL file.
 * Used by the reflector agent to log "Who did What, When, for Why".
 */
export class LogTool implements Tool {
  readonly name = 'log'
  readonly optIn = true
  readonly description =
    'Append a structured entry to today\'s log (memory/events/YYYY-MM-DD.jsonl). ' +
    'Use this to record what happened: who did what, when, and why.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      who: {
        type: 'string',
        description:
          'Actor (person, agent, system). A separate wiki page is not required.',
      },
      what: {
        type: 'string',
        description: 'Action or event description. Be concise.',
      },
      why: {
        type: 'string',
        description: 'Motivation or context for the action. Optional.',
      },
      challenge: {
        type: 'string',
        description:
          'Difficulty or blocker encountered during this event. Optional.',
      },
      refs: {
        type: 'array',
        description:
          'Related wiki item paths (e.g. "memory/topics/heartbeat.md"). Optional.',
        items: { type: 'string' },
      },
      session: {
        type: 'string',
        description:
          'The session this event belongs to (origin/provenance). ' +
          'Defaults to the current session.',
      },
      key: { type: 'string', description: 'For learning batches: stable event key, reused on retries (e.g. source message index plus decision name).' },
    },
    required: ['who', 'what'],
  }

  constructor(private workspace: string, private learningEvent?: (
    entry: { who: string; what: string; why?: string; challenge?: string; refs?: string[]; origin?: string },
    key: unknown, context: ExecutionContext,
  ) => string | undefined) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `📋 ${String(args.who ?? '')} — ${String(args.what ?? '')}`
  }

  async execute(
    args: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<string> {
    const who = String(args.who)
    const what = String(args.what)
    const why = args.why != null ? String(args.why) : undefined
    const challenge = args.challenge != null ? String(args.challenge) : undefined
    const refs = Array.isArray(args.refs)
      ? (args.refs as unknown[]).map(String)
      : undefined
    const origin = args.session != null
      ? String(args.session)
      : context?.sessionId
    if (context && this.learningEvent) {
      const result = this.learningEvent({ who, what, why, challenge, refs, origin }, args.key, context)
      if (result !== undefined) return result
    }

    const now = new Date()
    const entry: Record<string, unknown> = {
      when: now.toISOString(),
      who,
      what,
    }
    if (why) entry.why = why
    if (challenge) entry.challenge = challenge
    if (refs && refs.length > 0) entry.refs = refs
    if (origin) entry.origin = origin

    const dateStr = now.toISOString().slice(0, 10)
    const eventsDir = join(this.workspace, 'memory', 'events')
    const filePath = join(eventsDir, `${dateStr}.jsonl`)

    await mkdir(eventsDir, { recursive: true })
    await appendFile(filePath, JSON.stringify(entry) + '\n')

    return `Logged event: ${who} — ${what}` +
      (why ? ` (why: ${why})` : '') +
      (challenge ? ` [challenge: ${challenge}]` : '')
  }
}
