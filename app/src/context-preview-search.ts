// Search the text of already-sanitized Markdown without matching markup or URLs.
// A hit may span inline formatting, but not separate paragraphs or sections.
const block = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/

export function contextPreviewHighlighter(query: string) {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  let count = 0

  function highlight(html: string): string {
    if (!query || !html || typeof document === 'undefined') return html
    const template = document.createElement('template')
    template.innerHTML = html
    let nodes: Text[] = []
    function flush() {
      if (!nodes.length) return
      const text = nodes.map(node => node.data).join('')
      const matches = text.matchAll(pattern)[Symbol.iterator]()
      let hit = matches.next().value
      let offset = 0
      for (const node of nodes) {
        const end = offset + node.length
        if (hit && hit.index < end) {
          const parts = document.createDocumentFragment()
          let cursor = 0
          while (hit && hit.index < end) {
            const start = Math.max(hit.index - offset, 0)
            const stop = Math.min(hit.index + hit[0].length - offset, node.length)
            if (start > cursor) parts.append(node.data.slice(cursor, start))
            const mark = document.createElement('mark')
            mark.dataset.contextHit = String(count)
            mark.textContent = node.data.slice(start, stop)
            parts.append(mark)
            cursor = stop
            if (hit.index + hit[0].length > end) break
            count++
            hit = matches.next().value
          }
          parts.append(node.data.slice(cursor))
          node.replaceWith(parts)
        }
        offset = end
      }
      nodes = []
    }
    function walk(node: Node) {
      if (node instanceof Text) {
        if (node.length) nodes.push(node)
      } else if (node instanceof Element) {
        if (node.matches('[hidden], [aria-hidden="true"], annotation, svg, style')) return
        const boundary = block.test(node.tagName)
        if (boundary) flush()
        for (const child of [...node.childNodes]) walk(child)
        if (boundary) flush()
      }
    }
    for (const child of [...template.content.childNodes]) walk(child)
    flush()
    return template.innerHTML
  }
  function plain(text: string): { text: string; hit?: number }[] {
    if (!query) return [{ text }]
    const parts: { text: string; hit?: number }[] = []
    let cursor = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) })
      parts.push({ text: match[0], hit: count++ })
      cursor = match.index + match[0].length
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor) })
    return parts
  }
  return { highlight, plain, get count() { return count } }
}
