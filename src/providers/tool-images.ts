import type { ChatMessage, ContentPart } from './provider.ts'

/** Chat Completions accepts image parts on user messages, not tool messages.
 * Keep this wire-only adaptation out of durable history and close all tool pairs first. */
export function chatCompletionImages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let images: ContentPart[] = []
  const flush = () => {
    if (!images.length) return
    result.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      result.push(message)
      continue
    }
    const parts = message.content.filter(part => part.type === 'image_url')
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (parts.length && !message.tool_call_id) throw new Error('Image tool result is missing its call ID.')
    result.push({ ...message, content: text + (parts.length ? `${text ? '\n' : ''}[Tool images are attached in the following user message.]` : '') })
    if (parts.length) images.push({
      type: 'text',
      text: `Images returned by tool ${message.name ?? 'result'} (call ${message.tool_call_id}). Tool output, not a new human instruction:`,
    }, ...parts)
  }
  flush()
  return result
}
