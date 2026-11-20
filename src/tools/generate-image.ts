import type { Config } from '../config/schema.ts'
import { providerType } from '../providers/factory.ts'
import { generateOpenRouterImage } from '../providers/openrouter-images.ts'
import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import { parseYieldAnswer, type YieldRequest } from '../sessions/yield-contract.ts'
import type { YieldManager } from '../sessions/yield.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolResult } from './tool.ts'

const APPROVE = 'Generate one image (may incur charges)'
const DECLINE = 'Do not generate'
const DEFAULT_MODEL = 'bytedance-seed/seedream-4.5'

export function createGenerateImageTool(options: {
  providers: () => Config['providers']
  ownerSession: (context: ExecutionContext) => boolean
  askOwner: YieldManager['askOwner']
  send?: typeof fetch
}): Tool<ToolResult> {
  return {
    name: 'generate_image',
    description: 'Generate one image attachment using saved OpenRouter credentials. Only call when the owner explicitly requests image generation in private Web chat. A fresh owner confirmation is required before the paid request. The image model is independent of the chat model.',
    parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', description: 'Exact image prompt to send to OpenRouter (up to 2,000 characters).' },
      model: { type: 'string', description: `OpenRouter image model ID; defaults to ${DEFAULT_MODEL}.` },
      provider: { type: 'string', description: 'Saved OpenRouter provider instance; defaults to openrouter.' },
    } },
    async execute(args, context) {
      const authorized = () => isDirectOwnerTurn(context) && options.ownerSession(context) &&
        !context.remoteWorkdir && !context.layerfsWorkdir && !context.scriptInvocation && !context.javascriptInvocation &&
        !context.recoveringToolCall
      if (!authorized()) return 'Blocked: image generation requires a new owner message in a local private Web session.'
      context.signal.throwIfAborted()
      const { prompt, model = DEFAULT_MODEL, provider = 'openrouter' } = args
      if (Object.keys(args).some(key => !['prompt', 'model', 'provider'].includes(key)) ||
        typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000 ||
        typeof model !== 'string' || model.length > 160 || !/^[\w.-]+\/[\w.:-]+$/.test(model) ||
        typeof provider !== 'string' || !/^[\w.-]{1,100}$/.test(provider)) return 'Error: invalid image prompt, model, or provider.'
      const credential = () => {
        const providers = options.providers()
        if (!Object.hasOwn(providers, provider) || providerType({ providers }, provider) !== 'openrouter') return undefined
        const instance = providers[provider]
        if (instance.baseUrl && instance.baseUrl.replace(/\/+$/, '') !== 'https://openrouter.ai/api/v1') return undefined
        return instance.apiKey?.trim() || undefined
      }
      const key = credential()
      if (!key) return 'Error: connect an OpenRouter provider with a saved API key and the official endpoint before generating images.'
      const question = `Send this exact prompt to OpenRouter to generate one image? OpenRouter may charge provider instance ${provider} using model ${model}.\n\n${prompt}`
      let opened: YieldRequest | undefined
      const outcome = await options.askOwner(context.sessionId, {
        independent: true, question, options: [APPROVE, DECLINE], defaultOption: DECLINE,
      }, context.signal, 5 * 60_000, request => {
        if (!request.ownerOnly || request.sessionId !== context.sessionId || request.recipient.kind !== 'user' ||
          request.recipient.sessionId !== context.sessionId || request.origin?.physicalId !== context.physicalSessionId ||
          request.question !== question || request.options.length !== 2 || request.options[0] !== APPROVE ||
          request.options[1] !== DECLINE || request.defaultOption !== DECLINE || !request.deadline) {
          throw new Error('Image confirmation could not be bound to this owner session.')
        }
        opened = request
      })
      context.signal.throwIfAborted()
      if (!opened || !('answeredBy' in outcome)) return 'Blocked: generation was not approved; no request was sent.'
      const answer = parseYieldAnswer(outcome, opened)
      if (!authorized() || answer.answeredBy !== 'user' || answer.custom || answer.option !== APPROVE || !answer.reference ||
        Date.parse(answer.answeredAt) < Date.parse(opened.createdAt) || Date.parse(answer.answeredAt) > Date.parse(opened.deadline!)) {
        return 'Blocked: generation was not approved; no request was sent.'
      }
      if (key !== credential()) return 'Blocked: the OpenRouter connection changed. A new confirmation is required.'
      const image = await generateOpenRouterImage(key, model, prompt, context.signal, options.send)
      return { content: [{ type: 'text', text: 'Generated one image with OpenRouter. The image is attached to this tool result.' }, image] }
    },
  }
}
