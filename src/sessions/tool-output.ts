import type { ChatMessage } from '../providers/provider.ts'
import { MODEL_TOOL_TEXT_CHARS, outputPreview } from '../utils/output-preview.ts'
import { spillOutputPreview } from '../utils/output-spill.ts'

/** Final model boundary, including historical results and registry exceptions.
 * Do not rewrite stored history, tool call IDs, or image parts. */
export class ToolOutputProjection {
  private readonly spills = new WeakMap<ChatMessage, { sessionId: string; projected: Promise<ChatMessage> }>()

  constructor(private readonly home: string) {}

  async project(message: ChatMessage, sessionId: string, transient = false): Promise<ChatMessage> {
    if (message.role !== 'tool' || message.content == null) return message
    const cached = !transient && this.spills.get(message)
    if (cached && cached.sessionId === sessionId) return cached.projected
    const content = message.content
    const texts = typeof content === 'string' ? [content] : content.flatMap(part => part.type === 'text' ? [part.text] : [])
    const length = texts.reduce((total, text) => total + text.length, Math.max(0, texts.length - 1))
    if (length <= MODEL_TOOL_TEXT_CHARS) return message
    const text = texts.join('\n')
    const preview = transient
      // Trusted transient observations (e.g. computer use) must never be written to disk.
      ? Promise.resolve(outputPreview(text) + 'Full output was NOT saved: this observation is transient. Request a narrower observation.')
      : spillOutputPreview(this.home, sessionId, `tool-result-${message.name ?? 'history'}`, text)
    const projected = preview.then((value): ChatMessage => ({ ...message,
      content: typeof content === 'string' ? value : [
        { type: 'text', text: value }, ...content.filter(part => part.type !== 'text'),
      ],
    }))
    if (!transient) this.spills.set(message, { sessionId, projected })
    return projected
  }
}
