import type { Tool, ToolParameters } from './tool.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { SessionParent } from '../sessions/session-store.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'

/**
 * Tool that lets the agent send a message to another session.
 *
 * Emits both an outbound message (for channel display) and an
 * inbound message (for the target agent to process). Use `silent`
 * to record the message without triggering a response.
 */
export class MessageTool implements Tool {
  readonly name = 'message'
  readonly description = 'Send a message to another session (subagent or common session).'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Message text to send.' },
      sessionId: {
        type: 'string',
        description:
          'Target session ID (e.g. "discord:123456"). Must not be the current session.',
      },
      silent: {
        type: 'boolean',
        description:
          'If true, the message is recorded in history but does not trigger a response from the target agent.',
      },
    },
    required: ['content', 'sessionId'],
  }

  constructor(
    private bus: Bus,
    private isEphemeralSession: (sessionId: string) => boolean | Promise<boolean>,
    private getSessionParent: (sessionId: string) => SessionParent | undefined,
    private getChildSessions: (parentSessionId: string) => string[] | undefined,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const target = String(args.sessionId ?? '')
    const content = String(args.content ?? '')
    const preview = content.length > 40 ? content.slice(0, 40) + '…' : content
    return `💬 → ${target}: ${preview}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const rawContent = String(args.content ?? '')
    if (!rawContent) return 'Error: content is required'

    const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    if (!targetSessionId || !targetSessionId.includes(':')) {
      return 'Error: sessionId is required and must be in "channel:chatId" format.'
    }

    const currentSessionId = `${context.channel}:${context.chatId}`
    if (targetSessionId === currentSessionId) {
      return 'Error: cannot send a message to the current session.'
    }

    // Validate target is accessible: must be a child of this session or a common session
    const children = this.getChildSessions(currentSessionId)
    const isChild = children?.includes(targetSessionId) ?? false
    if (!isChild) {
      // Check if target is a common session (no parent, or parent is current session)
      const targetParent = this.getSessionParent(targetSessionId)
      if (targetParent && targetParent.id !== currentSessionId) {
        return `Error: cannot send messages to "${targetSessionId}" — it is a subagent owned by another session.`
      }
    }

    if (await this.isEphemeralSession(targetSessionId)) {
      return `Error: cannot send messages to ephemeral session "${targetSessionId}".`
    }

    const { text, media } = parseMediaFromContent(rawContent)
    const silent = args.silent === true

    const [channel, ...rest] = targetSessionId.split(':')
    const chatId = rest.join(':')

    // Emit outbound message (for channel display)
    const outbound: OutboundMessage = {
      event: 'response',
      channel,
      chatId,
      done: false,
      content: text,
      media,
    }
    this.bus.emit('message.outbound', outbound)

    // Emit inbound message (for the target agent to process)
    this.bus.emit('message.inbound', {
      channel,
      chatId,
      senderId: currentSessionId,
      senderName: context.senderName ?? 'Agent',
      messageId: crypto.randomUUID(),
      content: text,
      media,
      timestamp: new Date().toISOString(),
      silent: silent || undefined,
    })

    return `Message sent to ${targetSessionId}${silent ? ' (silent)' : ''}`
  }
}
