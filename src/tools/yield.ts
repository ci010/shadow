import type { ExecutionContext } from '../agent/agent.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion } from '../sessions/yield-contract.ts'
import type { Tool, ToolParameters } from './tool.ts'

const parameters = {
  type: 'object' as const,
  properties: {
    action: { type: 'string', enum: ['ask', 'answer'], default: 'ask', description: 'Ask a question or answer a child session’s request.' },
    question: { type: 'string', description: 'For ask: a clear question requiring a decision.' },
    options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, uniqueItems: true, description: 'For ask: exactly three distinct non-empty choices.' },
    default_option: { type: 'string', description: 'For ask: exactly one of options, used only if the configured timeout expires.' },
    request_id: { type: 'string', description: 'For answer: the request ID received from your child session.' },
    option: { type: 'string', description: 'For answer: the exact text of one of the child’s three options.' },
  },
  additionalProperties: false,
}

/** One coordination tool for both sides of a parent/child decision. */
export class YieldTool implements Tool {
  readonly name = 'yield'
  readonly readonly = false
  readonly supportsRemoteWorkdir = true
  readonly description = 'Yield for a decision with exactly three choices and one default. Root sessions ask the human; child sessions ask their stored parent. Waits until answered, cancelled, or the configured timeout selects the default. Use action="answer" to answer a child request. You cannot select the recipient or timeout.'
  readonly parameters: ToolParameters = parameters

  constructor(private readonly yields: YieldManager) {}

  async execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
    ctx.signal.throwIfAborted()
    const denied = ctx.tools?.executionDenial?.('yield', args)
    if (denied) return denied
    const action = args.action === undefined ? 'ask' : args.action
    const keys = action === 'ask'
      ? ['action', 'question', 'options', 'default_option']
      : ['action', 'request_id', 'option']
    if ((action !== 'ask' && action !== 'answer') || Object.keys(args).some(key => !keys.includes(key))) {
      throw new YieldError('invalid_request', 'Use action ask or answer and only the parameters for that action.')
    }
    if (action === 'answer') {
      if (typeof args.request_id !== 'string' || !args.request_id || typeof args.option !== 'string') {
        throw new YieldError('invalid_request', 'Answer requires request_id and option strings.')
      }
      return JSON.stringify(this.yields.answerParent(ctx.sessionId, args.request_id, args.option))
    }
    let question
    try {
      question = parseYieldQuestion({ question: args.question, options: args.options, defaultOption: args.default_option })
    } catch (error) {
      throw new YieldError('invalid_request', error instanceof Error ? error.message : String(error))
    }
    return JSON.stringify(await this.yields.ask(ctx.sessionId, question, ctx.signal,
      ctx.inputSource === 'user' ? { channel: ctx.channel, senderId: ctx.senderId } : undefined))
  }
}
