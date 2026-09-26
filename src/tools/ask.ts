import type { ExecutionContext } from './context.ts'
import type { InputRequests } from '../sessions/input-requests.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion, parseYieldReference } from '../sessions/yield-contract.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { WORK_APPROVE, WORK_REJECT } from '../initiatives/work-contract.ts'
import type { WorkAlignment } from '../sessions/work-alignment.ts'

const parameters = {
  type: 'object' as const,
  properties: {
    action: { type: 'string', enum: ['ask', 'context', 'invalidate'], default: 'ask', description: 'Ask for input, read the decision schema, or invalidate your own recorded premise.' },
    kind: { type: 'string', enum: ['decision', 'input'], description: 'Required for ask: decision preserves decision/authority constraints; input requests plain text without granting permission.' },
    proposal: { type: 'object', description: 'Decision only: {key,id} from work propose. The exact saved change is displayed for one human approval; do not supply question/options/default_option for this form.',
      properties: { key: { type: 'string' }, id: { type: 'string' } }, required: ['key', 'id'], additionalProperties: false },
    brief: { type: 'object', description: 'Decision only: required structured brief. Call action=context for the compact schema and genuine user-input references.' },
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

export class AskTool implements Tool {
  readonly name = 'ask'
  readonly readonly = false
  readonly supportsRemoteWorkdir = true
  readonly description = 'Ask and wait for required input. kind=input takes only question and returns text, never permission; an inbound A2A input goes to its authenticated caller. kind=decision requires a brief, options and default_option: read action=context for the schema and genuine source identities. Roots ask humans; children ask their stored parent. approved:false is not an answer: investigate or continue only authorized unaffected work. action=invalidate marks your obsolete decision premise. Use reply to answer a pending request; message/final text does not answer it.'
  readonly parameters: ToolParameters = parameters

  constructor(private readonly yields: YieldManager, private readonly inputs: Pick<InputRequests, 'get' | 'ask'>,
    private readonly work?: () => WorkAlignment | undefined) {}

  async execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
    ctx.signal.throwIfAborted()
    const denied = ctx.tools?.executionDenial?.('ask', args)
    if (denied) return denied
    const action = args.action === undefined ? 'ask' : args.action
    if (action === 'context' && Object.keys(args).every(key => key === 'action')) return JSON.stringify(await this.yields.context(ctx.sessionId))
    if (action === 'invalidate' && Object.keys(args).every(key => ['action', 'reference', 'reason'].includes(key))) {
      if (typeof args.reason !== 'string') throw new YieldError('invalid_request', 'Explain which premise changed.')
      return JSON.stringify(await this.yields.invalidateOwn(ctx.sessionId, parseYieldReference(args.reference), args.reason))
    }
    if (action === 'ask' && args.kind === 'input' && Object.keys(args).every(key => ['action', 'kind', 'question'].includes(key))) {
      if (typeof args.question !== 'string') throw new YieldError('invalid_request', 'Input requires a question.')
      return JSON.stringify(await this.inputs.ask(args.question, ctx))
    }
    if (action !== 'ask' || args.kind !== 'decision'
      || Object.keys(args).some(key => !['action', 'kind', 'question', 'options', 'default_option', 'sources', 'brief', 'reconsiders', 'proposal'].includes(key))) {
      throw new YieldError('invalid_request', 'Use ask(kind=input, question), ask(kind=decision, brief, question, options, default_option), context or invalidate. Answer requests with reply.')
    }
    if (ctx.channel === 'a2a') throw new YieldError('forbidden', 'An A2A caller is not a local human decision authority. Ask for ordinary input or report the authorization blocker.')
    if (this.inputs.get(ctx.sessionId, true)) throw new YieldError('conflict', 'This session already has a pending input request.')
    let question
    try {
      if (args.brief === undefined) throw new TypeError('A decision brief is required. Use action=context for its schema; label unverified premises as assumptions.')
      if (args.proposal !== undefined) {
        const proposal = args.proposal
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
          || Object.keys(proposal).some(key => !['key', 'id'].includes(key))
          || !('key' in proposal) || typeof proposal.key !== 'string' || !('id' in proposal) || typeof proposal.id !== 'string'
          || ['question', 'options', 'default_option', 'reconsiders'].some(key => key in args)) throw new TypeError('A work decision takes proposal={key,id} and brief, not an independently editable question.')
        const work = this.work?.()
        if (!work) throw new TypeError('Work proposal decisions are unavailable.')
        const binding = work.decision(proposal.key, proposal.id)
        question = parseYieldQuestion({ question: `Apply the proposed change to ${proposal.key} (revision ${binding.baseRevision})?`,
          options: [WORK_APPROVE, WORK_REJECT], defaultOption: WORK_REJECT,
          brief: args.brief, sources: args.sources, workProposal: binding })
      } else question = parseYieldQuestion({ question: args.question, options: args.options, defaultOption: args.default_option, sources: args.sources, brief: args.brief, reconsiders: args.reconsiders })
    } catch (error) {
      throw new YieldError('invalid_request', error instanceof Error ? error.message : String(error))
    }
    const stamps = question.workProposal
      ? [{ key: question.workProposal.key, revision: question.workProposal.baseRevision, assignmentRevision: question.workProposal.assignmentRevision }]
      : ctx.workStamps
    return JSON.stringify(await this.yields.ask(ctx.sessionId, question, ctx.signal,
      ctx.inputSource === 'user' ? { channel: ctx.channel, senderId: ctx.senderId } : undefined,
      ctx.inputSource === 'user' ? ctx.platformMessageId : undefined, ctx.toolCallId, stamps))
  }
}
