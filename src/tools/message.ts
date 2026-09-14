import type { Tool, ToolParameters } from './tool.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { SessionParent } from '../sessions/session-store.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import { sessionReplyAddress, type DeliverInput } from '../sessions/input.ts'

/**
 * Tool that lets the agent send a message to another session.
 *
 * Admits a typed session-origin input before projecting it to the channel.
 * Use `silent` to record the message without triggering a response.
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
    private canReceiveSessionMessage: (sessionId: string) => boolean,
    private getSessionParent: (sessionId: string) => SessionParent | undefined,
    private getChildSessions: (parentSessionId: string) => string[] | undefined,
    private deliver: DeliverInput,
    private canSendSessionMessage?: (sourceId: string, targetId: string) => boolean,
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
    const denied = context.tools?.executionDenial?.('message', args)
    if (denied) return denied
    const rawContent = String(args.content ?? '')
    if (!rawContent) return 'Error: content is required'

    const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    const reply = sessionReplyAddress(targetSessionId)
    if (!reply) {
      return 'Error: sessionId is required and must be in "channel:chatId" format.'
    }

    const currentSessionId = context.sessionId
    if (targetSessionId === currentSessionId) {
      return 'Error: cannot send a message to the current session.'
    }
    if (this.canSendSessionMessage && !this.canSendSessionMessage(currentSessionId, targetSessionId)) {
      return 'Error: task executions do not admit messages; create a new execution.'
    }

    // Validate target is accessible: must be a child of this session or a common session
    const children = this.getChildSessions(currentSessionId)
    const isChild = children?.includes(targetSessionId) ?? false
    if (!isChild) {
      // Check if target is a common session (no parent, or parent is current session)
      const targetParent = this.getSessionParent(targetSessionId)
      const ownParent = this.getSessionParent(currentSessionId)
      const isParent = ownParent?.id === targetSessionId
      const isSibling = !!ownParent && targetParent?.id === ownParent.id
      if (targetParent && targetParent.id !== currentSessionId && !isParent && !isSibling) {
        return `Error: cannot send messages to "${targetSessionId}" — it is a subagent owned by another session.`
      }
    }

    if (!this.canReceiveSessionMessage(targetSessionId)) {
      return `Error: task execution "${targetSessionId}" does not accept messages; create a new execution.`
    }

    const { text, media } = parseMediaFromContent(rawContent)
    const silent = args.silent === true

    await this.deliver(targetSessionId, {
      kind: 'message',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: {
        kind: 'session',
        sessionId: currentSessionId,
        inputId: context.messageId,
        senderName: context.senderName ?? 'Agent',
      },
      policy: silent ? 'silent' : 'queue',
      content: text,
      media,
    })

    const outbound: OutboundMessage = {
      event: 'response',
      channel: reply.channel,
      chatId: reply.chatId,
      done: false,
      content: text,
      media,
    }
    this.bus.emit('message.outbound', outbound)

    return `Message sent to ${targetSessionId}${silent ? ' (silent)' : ''}`
  }
}
