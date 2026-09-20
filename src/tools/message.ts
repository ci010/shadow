import type { Tool, ToolParameters } from './tool.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionParent } from '../sessions/session-store.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import { sessionReplyAddress, type DeliverInput, type SessionInputSource } from '../sessions/input.ts'
import { z } from 'zod'

const coordinationSchema = z.object({
  intent: z.enum(['request', 'question', 'progress', 'handoff', 'acknowledgement']).default('request'),
  initiativeId: z.string().trim().min(1).max(128).optional(),
  itemId: z.string().trim().min(1).max(128).optional(),
}).refine(value => !value.itemId || !!value.initiativeId, 'itemId requires initiativeId.')

/**
 * Tool that lets the agent send a message to another session.
 *
 * Admits a typed session-origin input before projecting it to the channel.
 * Use `silent` to record the message without triggering a response.
 */
export class MessageTool implements Tool {
  readonly name = 'message'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Send to a peer session in this Project. By default, queues a response after any active turn without interrupting it. Use this for tasks, required context and unblocking information. silent:true only archives: it neither updates the active turn nor wakes the recipient. A receipt confirms admission, not completion or transfer of Initiative assignment. Sleeping topics can receive messages; temporary executions cannot be reused.'
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
          'Default false: queue a response without interrupting active work. True only archives for a future turn; it does not update active context or wake an idle recipient. Never use true for required task materials, corrections, questions or instructions to continue.',
      },
      intent: { type: 'string', enum: ['request', 'question', 'progress', 'handoff', 'acknowledgement'], description: 'Descriptive purpose only; does not control scheduling. Use request for actionable follow-ups and required materials; progress for status reports. handoff does not mutate work ownership.' },
      initiativeId: { type: 'string', description: 'Optional existing Initiative in this Project.' },
      itemId: { type: 'string', description: 'Optional existing work item in initiativeId.' },
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
    private assertWorkReference?: (initiativeId: string, itemId?: string) => void,
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
    context.signal.throwIfAborted()
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

    let coordination: SessionInputSource['coordination']
    if (args.intent !== undefined || args.initiativeId !== undefined || args.itemId !== undefined) {
      coordination = coordinationSchema.parse({ intent: args.intent, initiativeId: args.initiativeId, itemId: args.itemId })
      if (coordination.initiativeId) {
        if (!this.assertWorkReference) throw new Error('Work-reference validation is not configured.')
        this.assertWorkReference(coordination.initiativeId, coordination.itemId)
      }
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
        ...(coordination ? { coordination } : {}),
      },
      policy: silent ? 'silent' : 'queue',
      content: text,
      media,
    })

    const outbound: OutboundMessage = {
      event: 'response',
      channel: reply.channel,
      chatId: reply.chatId,
      ...(reply.channelAddress ? { channelAddress: reply.channelAddress } : {}),
      done: false,
      content: text,
      media,
    }
    this.bus.emit('message.outbound', outbound)

    const scheduling = silent
      ? 'Recorded only: not injected into the active turn and will not wake the recipient. A later non-silent message is required for processing; send a non-silent request if this needs action.'
      : 'Queued for a response after any active turn, without interrupting it.'
    return `Message sent to ${targetSessionId}${silent ? ' (silent)' : ''}. ${scheduling} Receipt confirms admission only; work ownership is unchanged.`
  }
}
