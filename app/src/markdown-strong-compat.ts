// markdown-exit runs this before text_join so escaped text stays a boundary.
export function exitStrongCompatibility(md: import('markdown-exit').MarkdownExit): void {
  md.core.ruler.before('text_join', 'padded_strong', state => {
    for (const block of state.tokens) {
      const children = block.children
      if (!children || children.some(t => t.type === 'html_inline')) continue
      let linkDepth = 0
      for (let i = 0; i < children.length; i++) {
        const token = children[i]!
        if (token.type === 'link_open') linkDepth++
        if (token.type === 'link_close') linkDepth--
        if (linkDepth || token.type !== 'text' || /[$\x00]/.test(token.content)) continue
        // Preserve escaped delimiter runs across separate text_special tokens.
        if (children[i - 1]?.type === 'text_special' && token.content.startsWith('*')) continue
        const pattern = /(?<![*\\])\*\*([^*\\`_$<>\[\]\x00\r\n]{1,200})\*\*(?!\*)/gu
        const parts: import('markdown-exit').Token[] = []
        let cursor = 0
        for (const match of token.content.matchAll(pattern)) {
          const inner = match[1]!, trimmed = inner.trim()
          const before = token.content.slice(0, match.index).match(/.$/u)?.[0] ?? ''
          const after = token.content.slice(match.index + match[0].length)
          const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
          const padded = /^[ \t]|[ \t]$/.test(inner) && !/[\p{L}\p{N}]/u.test(before)
          const punct = inner === trimmed && /\p{P}$/u.test(inner) && cjk.test(Array.from(after)[0] ?? '') && (!/[\p{L}\p{N}]/u.test(before) || cjk.test(before))
          if (!trimmed || (!padded && !punct)) continue
          const make = (type: string, tag: string, nesting: -1 | 0 | 1, content = '') => { const t = new state.Token(type, tag, nesting); t.content = content; return t }
          if (match.index > cursor) parts.push(make('text', '', 0, token.content.slice(cursor, match.index)))
          parts.push(make('strong_open', 'strong', 1), make('text', '', 0, trimmed), make('strong_close', 'strong', -1))
          cursor = match.index + match[0].length
        }
        if (!parts.length) continue
        if (cursor < token.content.length) { const tail = new state.Token('text', '', 0); tail.content = token.content.slice(cursor); parts.push(tail) }
        children.splice(i, 1, ...parts); i += parts.length - 1
      }
    }
  })
}
