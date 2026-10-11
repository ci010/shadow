import type { Tool, ToolParameters } from './tool.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionParent } from '../sessions/session-store.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import { sessionReplyAddress, type DeliverInput, type SessionInputSource, type SessionMessageInput } from '../sessions/input.ts'
import { buildSenderTag } from '../agent/message-builder.ts'
import { z } from 'zod'
import type { WorkStamp } from '../initiatives/work-contract.ts'
import type { A2aSessions } from '../a2a/sessions.ts'

const coordinationSchema = z.object({
  intent: z.enum(['request', 'question', 'progress', 'handoff', 'acknowledgement']).default('request'),
  initiativeId: z.string().trim().min(1).max(600).optional(),
  itemId: z.string().trim().min(1).max(128).optional(),
}).refine(value => !value.itemId || !!value.initiativeId, 'itemId requires initiativeId.')

/**
 * Tool that lets the agent send a message to another session.
 *
 * Admits a typed session-origin input before projecting it to the channel.
 * Use delivery=silent to record a message without triggering a response.
 */
export class MessageTool implements Tool {
  readonly name = 'message'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Send concise actionable context to an agent in this Project: sessionId + content normally suffice. Relevant context enters its next safe step, without interrupting tools. Your running task accepts corrections to its existing assignment, not another task. Use delivery=queue for subsequent work. Routine progress/acknowledgements archive. Admission is not application or ownership transfer; wait for completion or confirmed cancellation before taking over its files.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Message text to send.' },
      delivery: { type: 'string', enum: ['next-step', 'queue', 'silent'], description: 'Default next-step: context for current work. queue: a later request after the turn. silent: FYI archive only. Running tasks only accept next-step from their actual parent.' },
      sessionId: {
        type: 'string',
        description:
          'Target session ID from discovery or a prior receipt, including remote:<id> for an owned A2A conversation. Must not be the current session.',
      },
      intent: { type: 'string', enum: ['request', 'question', 'progress', 'handoff', 'acknowledgement'], description: 'Progress and acknowledgement default to routine archival; required action/materials use request. handoff does not mutate work ownership.' },
      attention: { type: 'string', enum: ['routine', 'milestone', 'blocker', 'decision', 'correction'], description: 'Routine status is archived by default. Other values require a response and cannot be silent. Do not hide failures or corrections as routine progress.' },
      initiativeId: { type: 'string', description: 'Optional existing Initiative in this Project.' },
      itemId: { type: 'string', description: 'Optional existing work item in initiativeId.' },
    },
    required: ['content', 'sessionId'],
  }

  constructor(
    private bus: Bus,
    private canReceiveSessionMessage: (sessionId: string, sourceId?: string) => boolean,
    private getSessionParent: (sessionId: string) => SessionParent | undefined,
    private getChildSessions: (parentSessionId: string) => string[] | undefined,
    private deliver: DeliverInput,
    private canSendSessionMessage?: (sourceId: string, targetId: string) => boolean,
    private assertWorkReference?: (initiativeId: string, itemId?: string) => void,
    private workIsCurrent?: (stamps: WorkStamp[]) => boolean,
    private remote?: Pick<A2aSessions, 'message'>,
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
    if (targetSessionId.startsWith('remote:')) {
      if (!this.remote) throw new Error('A2A is not configured in this Project.')
      if (Object.keys(args).some(key => !['sessionId', 'content'].includes(key))) {
        throw new Error('Remote messages accept only sessionId and content; silent, coordination and Initiative metadata are not supported.')
      }
      if (context.workStamps?.length && this.workIsCurrent?.(context.workStamps) === false) {
        throw new Error('Work basis changed; an obsolete message cannot be sent to a remote agent.')
      }
      if (typeof args.content !== 'string') throw new Error('Remote message content must be text.')
      const { media } = parseMediaFromContent(args.content)
      if (media?.length) throw new Error('A2A messages support text only; media is not forwarded.')
      return this.remote.message(targetSessionId, args.content, context)
    }
    const reply = sessionReplyAddress(targetSessionId)
    if (!reply) {
      return 'Error: sessionId is required and must be in "channel:chatId" format.'
    }

    const currentSessionId = context.sessionId
    if (targetSessionId === currentSessionId) {
      return 'Error: cannot send a message to the current session.'
    }
    if (this.canSendSessionMessage && !this.canSendSessionMessage(currentSessionId, targetSessionId)) {
      return 'Error: target does not admit this message. Only the actual parent may correct its running task. A failed send does not stop it or transfer its files.'
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

    if (!this.canReceiveSessionMessage(targetSessionId, currentSessionId)) {
      return `Error: execution "${targetSessionId}" cannot accept this message. Inspect its state; do not take over its files until completion or confirmed cancellation.`
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
    const attention = args.attention === undefined ? undefined
      : z.enum(['routine', 'milestone', 'blocker', 'decision', 'correction']).parse(args.attention)
    // Keep old histories/callers readable without advertising two scheduling controls.
    // Explicit false means non-archival delivery, never an implicit second assignment.
    const legacySilent = args.silent === undefined ? undefined : z.boolean().parse(args.silent)
    const requestedDelivery = args.delivery === undefined ? undefined : z.enum(['next-step', 'queue', 'silent']).parse(args.delivery)
    if (requestedDelivery && legacySilent !== undefined) throw new Error('Use delivery only; do not combine delivery with legacy silent.')
    const explicitDelivery = requestedDelivery ?? (legacySilent === undefined ? undefined : legacySilent ? 'silent' : 'next-step')
    if (attention && attention !== 'routine' && explicitDelivery === 'silent') throw new Error('Important work updates cannot be silently archived.')
    const routine = attention === 'routine' || (!attention && ['progress', 'acknowledgement'].includes(coordination?.intent ?? ''))
    const stale = !!context.workStamps?.length && this.workIsCurrent?.(context.workStamps) === false
    const delivery = stale ? 'silent' : explicitDelivery ?? (routine ? 'silent' : 'next-step')

    const input: SessionMessageInput = {
      kind: 'message',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: {
        kind: 'session',
        sessionId: currentSessionId,
        inputId: context.messageId,
        senderName: context.senderName ?? 'Agent',
        ...(coordination ? { coordination } : {}),
        ...(context.workStamps?.length ? { workStamps: context.workStamps } : {}),
      },
      policy: delivery,
      content: stale ? `[Historical update from an obsolete work revision; not a new instruction or completion.]\n${text}` : text,
      media,
    }
    const receipt = await this.deliver(targetSessionId, input)

    const outbound: OutboundMessage = {
      event: 'response',
      channel: reply.channel,
      chatId: reply.chatId,
      ...(reply.channelAddress ? { channelAddress: reply.channelAddress } : {}),
      done: false,
      content: input.content,
      media,
      sessionMessage: {
        role: 'user', name: input.source.kind === 'session' ? input.source.senderName : undefined,
        timestamp: input.timestamp,
        content: [{ type: 'text', text: buildSenderTag(input) }, { type: 'text', text: input.content }],
      },
    }
    this.bus.emit('message.outbound', outbound)

    const scheduling = receipt.delivery ?? input.policy
    return `Message sent to ${targetSessionId}; inputId=${input.id}; delivery=${scheduling}. Receipt confirms admission only, not yet applied; ownership is unchanged.${stale ? ' Obsolete work version: evidence only.' : ''}`
  }
}
