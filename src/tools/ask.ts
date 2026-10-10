import type { ExecutionContext } from './context.ts'
import type { InputRequests } from '../sessions/input-requests.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion, parseYieldReference, type YieldOutcome } from '../sessions/yield-contract.ts'
import type { InputAnswer } from '../sessions/input-request.ts'
import type { Tool, ToolParameters, ToolResult } from './tool.ts'
import { buildMediaParts } from '../agent/message-builder.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'
import { channelSupportsAsk, CHAT_QUESTION_GUIDANCE } from './ask-policy.ts'

const parameters = {
  type: 'object' as const,
  properties: {
    action: { type: 'string', enum: ['ask', 'context', 'invalidate'], default: 'ask', description: 'Ask for input, read the decision schema, or invalidate your own recorded premise.' },
    kind: { type: 'string', enum: ['decision', 'input'], description: 'Required for ask: decision preserves decision/authority constraints; input requests plain text without granting permission.' },
    workKey: { type: 'string', description: 'Optional originating work node. Defaults to your focused or only active assignment; never create a work item merely to ask.' },
    decisionKey: { type: 'string', description: 'Optional ancestor of workKey whose goal or approach this choice changes. The host attaches the complete goal path; explain the choice at this level, not as a raw implementation failure.' },
    brief: { type: 'object', description: 'Optional detailed evidence brief, only when useful. The goal path is attached automatically; do not repeat it here. action=context provides the schema.' },
    reconsiders: { type: 'object', description: 'Decision only: earlier reference {sessionId, physicalId, requestId} being revisited after investigation, deferral or invalidation. Historical link only; do not put invalidated premises in sources.' },
    reference: { type: 'object', description: 'For invalidate: own decision reference {sessionId, physicalId, requestId}.' },
    reason: { type: 'string', description: 'For invalidate: which premise changed and why dependent decisions need revalidation.' },
    question: { type: 'string', description: 'A clear question for missing input or a consequential decision.' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, uniqueItems: true, description: 'Decision only: two distinct non-empty suggested choices. The UI automatically provides a third, custom-response entry; do not generate an Other or free-text option.' },
    default_option: { type: 'string', description: 'Decision only: exactly one of options, used only if the configured timeout expires.' },
    sources: { type: 'array', minItems: 1, maxItems: 3, description: 'Decision only: optional existing references. Copy an answer receipt’s reference, or sessionId, origin.physicalId and id (as requestId) from a received request. Links provide context, not permission or proof of causation.',
      items: { type: 'object', properties: {
        sessionId: { type: 'string' }, physicalId: { type: 'string' }, requestId: { type: 'string' },
      }, required: ['sessionId', 'physicalId', 'requestId'], additionalProperties: false } },
  },
  additionalProperties: false,
}

export class AskTool implements Tool<ToolResult> {
  readonly name = 'ask'
  readonly readonly = false
  readonly supportsRemoteWorkdir = true
  readonly description = 'Ask in the context of the goal, then wait. kind=input returns text, never permission. kind=decision needs question, two options and default_option; brief is optional. Set workKey for where the issue arose and decisionKey for the ancestor it changes; the host attaches the goal path automatically. Phrase the question as an outcome-level choice. Resolve local implementation choices yourself; a blocked approach may be replaced instead of escalated. Roots ask humans, children ask their stored parent. approved:false permits only investigation or authorized unaffected work. Use reply for pending requests; messages do not answer them.'
  readonly parameters: ToolParameters = parameters

  constructor(private readonly yields: YieldManager, private readonly inputs: Pick<InputRequests, 'get' | 'ask'>,
    private readonly work?: () => WorkAlignment | undefined) {}

  async execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    ctx.signal.throwIfAborted()
    if (!channelSupportsAsk(ctx.channel, ctx.sessionId) || !channelSupportsAsk(ctx.channelAddress?.platform)) {
      throw new YieldError('forbidden', CHAT_QUESTION_GUIDANCE)
    }
    const denied = ctx.tools?.executionDenial?.('ask', args)
    if (denied) return denied
    const action = args.action === undefined ? 'ask' : args.action
    if (action === 'context' && Object.keys(args).every(key => key === 'action')) return JSON.stringify(await this.yields.context(ctx.sessionId))
    if (action === 'invalidate' && Object.keys(args).every(key => ['action', 'reference', 'reason'].includes(key))) {
      if (typeof args.reason !== 'string') throw new YieldError('invalid_request', 'Explain which premise changed.')
      return JSON.stringify(await this.yields.invalidateOwn(ctx.sessionId, parseYieldReference(args.reference), args.reason))
    }
    for (const field of ['workKey', 'decisionKey']) {
      const key = args[field]
      if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 600)) {
        throw new YieldError('invalid_request', 'Work and decision keys must contain 1 to 600 characters.')
      }
    }
    const workContext = action === 'ask' ? this.work?.()?.decisionContext(ctx.sessionId,
      typeof args.workKey === 'string' ? args.workKey : undefined,
      typeof args.decisionKey === 'string' ? args.decisionKey : undefined) : undefined
    if ((args.workKey || args.decisionKey) && !workContext) throw new YieldError('unavailable', 'Project work context is unavailable.')
    if (action === 'ask' && args.kind === 'input' && Object.keys(args).every(key => ['action', 'kind', 'question', 'workKey', 'decisionKey'].includes(key))) {
      if (typeof args.question !== 'string') throw new YieldError('invalid_request', 'Input requires a question.')
      return this.answerResult(await this.inputs.ask(args.question, ctx, workContext), ctx)
    }
    if (action !== 'ask' || args.kind !== 'decision'
      || Object.keys(args).some(key => !['action', 'kind', 'question', 'options', 'default_option', 'sources', 'brief', 'reconsiders', 'workKey', 'decisionKey'].includes(key))) {
      throw new YieldError('invalid_request', 'Use ask(kind=input, question), ask(kind=decision, question, options, default_option), context or invalidate. Brief is optional. Answer requests with reply.')
    }
    if (ctx.channel === 'a2a') throw new YieldError('forbidden', 'An A2A caller is not a local human decision authority. Ask for ordinary input or report the authorization blocker.')
    if (this.inputs.get(ctx.sessionId, true)) throw new YieldError('conflict', 'This session already has a pending input request.')
    let question
    try {
      question = parseYieldQuestion({ question: args.question, options: args.options, defaultOption: args.default_option,
        sources: args.sources, brief: args.brief, reconsiders: args.reconsiders, workContext })
    } catch (error) {
      throw new YieldError('invalid_request', error instanceof Error ? error.message : String(error))
    }
    return this.answerResult(await this.yields.ask(ctx.sessionId, question, ctx.signal,
      ctx.inputSource === 'user' ? { channel: ctx.channel, senderId: ctx.senderId } : undefined,
      ctx.inputSource === 'user' ? ctx.platformMessageId : undefined, ctx.toolCallId, ctx.workStamps), ctx)
  }

  private async answerResult(answer: InputAnswer | YieldOutcome, ctx: ExecutionContext): Promise<ToolResult> {
    const text = JSON.stringify(answer)
    if (!('media' in answer) || !answer.media?.length) return text
    return { content: [{ type: 'text', text }, ...await buildMediaParts(answer.media, ctx.cwd ?? '.', ctx.cwd ?? '.', ctx.signal)] }
  }
}
