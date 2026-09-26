import type { ExecutionContext } from './context.ts'
import type { Tool } from './tool.ts'
import { YieldError, type YieldManager } from '../sessions/yield.ts'
import type { InputRequests } from '../sessions/input-requests.ts'
import type { A2aSessions } from '../a2a/sessions.ts'

export class ReplyTool implements Tool {
  readonly name = 'reply'
  readonly readonly = false
  readonly supportsRemoteWorkdir = true
  readonly description = 'Answer a specific pending request using its returned request_id. For a child decision, text must exactly match an offered option. For ordinary local/remote input, text is the requested information, never new authorization. Only the stored parent or remote task owner may reply. Does not send a general message or replace final responses.'
  readonly parameters = {
    type: 'object' as const,
    properties: {
      request_id: { type: 'string' as const, description: 'Exact pending request ID from ask notification or remote execution lookup.' },
      text: { type: 'string' as const, description: 'Requested answer, or exact decision option.' },
    },
    required: ['request_id', 'text'], additionalProperties: false,
  }
  constructor(private readonly yields: YieldManager, private readonly inputs: InputRequests,
    private readonly remote?: Pick<A2aSessions, 'reply'>) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const denied = context.tools?.executionDenial?.('reply', args)
    if (denied) return denied
    if (Object.keys(args).some(key => key !== 'request_id' && key !== 'text')
      || typeof args.request_id !== 'string' || !args.request_id || typeof args.text !== 'string') {
      throw new YieldError('invalid_request', 'Reply requires only request_id and text.')
    }
    if (args.request_id.startsWith('remote:')) {
      if (!this.remote) throw new YieldError('unavailable', 'A2A is not configured.')
      return this.remote.reply(args.request_id, args.text, context)
    }
    return JSON.stringify(await (this.inputs.has(args.request_id)
      ? this.inputs.replyParent(context.sessionId, args.request_id, args.text)
      : this.yields.answerParent(context.sessionId, args.request_id, args.text)))
  }
}
