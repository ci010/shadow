import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export interface ConversationSearchEntry {
  segmentId: string | null
  messageIndex: number
  blocks: string[]
}

export interface ConversationSearchMatch {
  entry: ConversationSearchEntry
  blockIndex: number
  start: number
  end: number
}

export interface ConversationSearchSegment {
  id: string | null
  previousId: string | null
  data: Record<string, unknown> & { messages: unknown[] }
}

export function textMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query.trim()) return []
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  return Array.from(text.matchAll(expression), match => ({ start: match.index, end: match.index + match[0].length }))
}

export function conversationMatches(entries: ConversationSearchEntry[], query: string): ConversationSearchMatch[] {
  return entries.flatMap(entry => entry.blocks.flatMap((text, blockIndex) =>
    textMatches(text, query).map(match => ({ entry, blockIndex, ...match }))))
}

export function isConversationFindKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    && !event.isComposing && event.keyCode !== 229 && event.key.toLowerCase() === 'f'
}

/** Physical reads are untruncated; the logical/model history can omit older segments. */
export async function loadConversationSearchHistory(base: string, sessionId: string, signal: AbortSignal): Promise<ConversationSearchSegment[]> {
  const segments: ConversationSearchSegment[] = []
  const visited = new Set<string>()
  let key: string | null = sessionId
  while (key !== null) {
    signal.throwIfAborted()
    if (visited.has(key)) throw new Error(t('Conversation history contains a segment cycle. Reopen the conversation and retry.'))
    visited.add(key)
    const response = await fetch(apiUrl(base, `/api/sessions/${encodeURIComponent(key)}`, { shallow: 'true' }), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error(t('Could not load conversation history for search ({status}). Retry search.', { status: response.status }))
    const data: unknown = await response.json()
    if (!isRecord(data) || !Array.isArray(data.messages)
      || !(data.previousPhysicalId === null || typeof data.previousPhysicalId === 'string')) {
      throw new Error(t('Invalid conversation search history. Reopen the conversation and retry.'))
    }
    segments.push({ id: segments.length ? key : null, previousId: data.previousPhysicalId, data: { ...data, messages: data.messages } })
    key = data.previousPhysicalId
  }
  return segments.reverse()
}

const blockTags = new Set(['P', 'DIV', 'PRE', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SUMMARY'])

export interface SearchTextBlock {
  text: string
  nodes: Array<{ node: Text; start: number }>
}

/** Keep inline Markdown/code tokens together without matching across separate paragraphs. */
export function searchTextBlocks(root: Element): SearchTextBlock[] {
  const document = root.ownerDocument
  const blocks: SearchTextBlock[] = []
  let owner: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      return !parent || parent.closest('script, style, textarea, select, [hidden], [aria-hidden="true"], .thinking-block')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    let block = node.parentElement!
    while (block !== root && !blockTags.has(block.tagName)) block = block.parentElement!
    if (owner !== block) { blocks.push({ text: '', nodes: [] }); owner = block }
    const current = blocks[blocks.length - 1]!
    current.nodes.push({ node, start: current.text.length })
    current.text += node.data
  }
  return blocks
}

export function searchRange(block: SearchTextBlock, start: number, end: number): Range | undefined {
  const first = block.nodes.find(item => item.start + item.node.length > start)
  const last = block.nodes.find(item => item.start + item.node.length >= end)
  if (!first || !last) return undefined
  const range = first.node.ownerDocument.createRange()
  range.setStart(first.node, start - first.start)
  range.setEnd(last.node, end - last.start)
  return range
}

const highlights = new Map<string, { ranges: Range[]; active: Range }>()
export function setConversationHighlights(owner: string, ranges?: Range[], active?: Range): void {
  if (ranges && active) highlights.set(owner, { ranges, active })
  else highlights.delete(owner)
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') {
    if (ranges) throw new Error(t('Conversation search highlighting requires a newer browser. Update your browser and retry.'))
    return
  }
  if (!highlights.size) {
    CSS.highlights.delete('shadow-conversation-matches')
    CSS.highlights.delete('shadow-conversation-active')
    return
  }
  const all = new Highlight()
  const current = new Highlight()
  for (const item of highlights.values()) {
    for (const range of item.ranges) all.add(range)
    current.add(item.active)
  }
  CSS.highlights.set('shadow-conversation-matches', all)
  current.priority = 1
  CSS.highlights.set('shadow-conversation-active', current)
}
