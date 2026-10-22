import type { ChatMessage, ContentPart } from './provider.ts'

const qqStickerPattern = /<faceType=6,faceId="[^"<>\r\n]*",ext="[^"<>\r\n]*">/g

export function qqStickerCount(text: string): number {
  return [...text.matchAll(qqStickerPattern)].length
}

/** Project stored/display content without rewriting history or provider tool pairing. */
export function modelMessages(messages: ChatMessage[], legacyQQ = false): ChatMessage[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message
    const images = message.content.filter(part => part.type === 'image_url')
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    // Old records have no classification. Only suppress an unambiguous all-sticker payload.
    const legacySticker = legacyQQ && message.role === 'user' && images.length > 0 &&
      images.every(part => part.displayOnly === undefined) && qqStickerCount(text) === images.length &&
      !/Quoted QQ message|QQ forwarded message element|QQ parallel message element/.test(text)
    let omitted = false
    const content: ContentPart[] = []
    for (const part of message.content) {
      if (part.type !== 'image_url') { content.push(part); continue }
      if (part.displayOnly === true || legacySticker) { omitted = true; continue }
      const { displayOnly: _local, ...image } = part
      content.push(image)
    }
    if (omitted) {
      let labelled = false
      for (let index = 0; index < content.length; index++) {
        const part = content[index]
        if (part.type === 'text' && qqStickerCount(part.text)) {
          content[index] = { ...part, text: part.text.replace(qqStickerPattern, '[QQ sticker omitted]') }
          labelled = true
        }
      }
      if (!labelled) content.push({ type: 'text', text: '[Sticker image omitted]' })
    }
    return { ...message, content }
  })
}
