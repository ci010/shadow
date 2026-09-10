import type { ChatMessage } from '../providers/provider.ts'

export function estimateTokens(messages: ChatMessage[]): number {
  // Simple heuristic: 1 token per 4 characters, plus 10 tokens per message for metadata
  const textTokens = messages.reduce((sum, msg) => {
    const contentLength = typeof msg.content === 'string'
      ? msg.content.length
      : Array.isArray(msg.content)
        ? msg.content.reduce(
          (len, part) =>
            len +
            (part.type === 'text' ? part.text.length : part.image_url.url.length ?? 0),
          0,
        )
        : 0
    return sum + contentLength / 4 + 10
  }, 0)
  return Math.ceil(textTokens)
}