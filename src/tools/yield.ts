import type { ExecutionContext } from './context.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion, parseYieldReference } from '../sessions/yield-contract.ts'
import type { Tool, ToolParameters } from './tool.ts'

const parameters = {
  type: 'object' as const,
  properties: {
    action: { type: 'string', enum: ['ask', 'answer', 'context', 'invalidate'], default: 'ask', description: 'Read context/schema, ask, answer your child, or invalidate your own recorded premise.' },
    brief: { type: 'object', description: 'For ask: required structured decision brief. Call action=context for the compact schema and genuine user-input references.' },
    reconsiders: { type: 'object', description: 'For ask: earlier decision reference {sessionId, physicalId, requestId} being revisited after investigation, deferral or invalidation. Historical link only; do not put invalidated premises in sources.' },
    reference: { type: 'object', description: 'For invalidate: own decision reference {sessionId, physicalId, requestId}.' },
    reason: { type: 'string', description: 'For invalidate: which premise changed and why dependent decisions need revalidation.' },
    question: { type: 'string', description: 'For ask: a clear question requiring a decision.' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, uniqueItems: true, description: 'For ask: two distinct non-empty suggested choices. The UI automatically provides a third, custom-response entry; do not generate an Other or free-text option.' },
    default_option: { type: 'string', description: 'For ask: exactly one of options, used only if the configured timeout expires.' },
    sources: { type: 'array', minItems: 1, maxItems: 3, description: 'For ask: optional existing decision references. Copy an answer receipt’s reference, or sessionId, origin.physicalId and id (as requestId) from a received request. Links provide context, not permission or proof of causation.',
      items: { type: 'object', properties: {
        sessionId: { type: 'string' }, physicalId: { type: 'string' }, requestId: { type: 'string' },
      }, required: ['sessionId', 'physicalId', 'requestId'], additionalProperties: false } },
    request_id: { type: 'string', description: 'For answer: the request ID received from your child session.' },
    option: { type: 'string', description: 'For answer: the exact text of one of the child’s options.' },
  },
  additionalProperties: false,
}

/** One coordination tool for both sides of a parent/child decision. */
export class YieldTool implements Tool {
  readonly name = 'yield'
  readonly readonly = false
  readonly supportsRemoteWorkdir = true
  readonly description = 'Use action=context for the decision brief schema and genuine source identities before asking. A brief separates goal, evidence, assumptions, proposal, tradeoffs and blocked/unaffected work. Root sessions ask the human; children ask their parent. A result with approved:false is NOT an answer: investigate or continue only already-authorized unaffected work, then ask a new linked question. Invalidate an obsolete premise to flag dependent decisions for revalidation. Reporting responsibility and citations grant no answer or execution authority.'
  readonly parameters: ToolParameters = parameters

  constructor(private readonly yields: YieldManager) {}

  async execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
    ctx.signal.throwIfAborted()
    const denied = ctx.tools?.executionDenial?.('yield', args)
    if (denied) return denied
    const action = args.action === undefined ? 'ask' : args.action
    if (action === 'context' && Object.keys(args).every(key => key === 'action')) return JSON.stringify(await this.yields.context(ctx.sessionId))
    if (action === 'invalidate' && Object.keys(args).every(key => ['action', 'reference', 'reason'].includes(key))) {
      if (typeof args.reason !== 'string') throw new YieldError('invalid_request', 'Explain which premise changed.')
      return JSON.stringify(await this.yields.invalidateOwn(ctx.sessionId, parseYieldReference(args.reference), args.reason))
    }
    const keys = action === 'ask'
      ? ['action', 'question', 'options', 'default_option', 'sources', 'brief', 'reconsiders']
      : ['action', 'request_id', 'option']
    if ((action !== 'ask' && action !== 'answer') || Object.keys(args).some(key => !keys.includes(key))) {
      throw new YieldError('invalid_request', 'Use action context, ask, answer or invalidate and only the parameters for that action.')
    }
    if (action === 'answer') {
      if (typeof args.request_id !== 'string' || !args.request_id || typeof args.option !== 'string') {
        throw new YieldError('invalid_request', 'Answer requires request_id and option strings.')
      }
      return JSON.stringify(await this.yields.answerParent(ctx.sessionId, args.request_id, args.option))
    }
    let question
    try {
      if (args.brief === undefined) throw new TypeError('A decision brief is required. Use action=context for its schema; label unverified premises as assumptions.')
      question = parseYieldQuestion({ question: args.question, options: args.options, defaultOption: args.default_option, sources: args.sources, brief: args.brief, reconsiders: args.reconsiders })
    } catch (error) {
      throw new YieldError('invalid_request', error instanceof Error ? error.message : String(error))
    }
    return JSON.stringify(await this.yields.ask(ctx.sessionId, question, ctx.signal,
      ctx.inputSource === 'user' ? { channel: ctx.channel, senderId: ctx.senderId } : undefined,
      ctx.inputSource === 'user' ? ctx.platformMessageId : undefined, ctx.toolCallId, ctx.workStamps))
  }
}
