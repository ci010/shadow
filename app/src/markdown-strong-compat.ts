import type { MarkedExtension, Token, Tokens } from 'marked'

// Display-only compatibility for padded or CJK punctuation-ended plain-text
// strong labels from LLMs.
// Work on already-lexed text, never on the Markdown source: code, escapes,
// links, HTML and math are boundaries, not text to normalize. Deliberately do
// not support nested markup, multiline spans, underscores or star runs.
export function paddedStrongCompatibility(): MarkedExtension {
  const pattern = /(?<![*\\])\*\*([^*\\`_$<>\[\]\x00\r\n]{1,200})\*\*(?!\*)/gu
  function repair(tokens: Token[]): void {
    // Raw HTML can open a container spanning several sibling text tokens.
    // Leave the entire inline container alone rather than guess its scope.
    if (tokens.some(token => token.type === 'html' && !token.block)) return
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.type === 'link' || token.type === 'image' || token.type === 'code' || token.type === 'codespan') continue
      if ('tokens' in token && Array.isArray(token.tokens)) repair(token.tokens)
      if (token.type === 'list') for (const item of token.items) repair(item.tokens)
      if (token.type === 'table') {
        for (const cell of [...token.header, ...token.rows.flat()]) repair(cell.tokens)
      }
      if (token.type !== 'text' || token.escaped || 'tokens' in token || token.raw !== token.text || /[$\x00]/.test(token.text)) continue
      // An escaped star immediately before this token may be part of a
      // literal delimiter run. Do not reinterpret the remaining stars.
      const previous = tokens[i - 1]
      if (previous?.type === 'escape' && previous.text === '*' && token.text.startsWith('*')) continue
      const replacements: Token[] = []
      let cursor = 0
      pattern.lastIndex = 0
      for (const match of token.text.matchAll(pattern)) {
        const inner = match[1]!
        const trimmed = inner.trim()
        const source: string = token.text
        const before = source.slice(0, match.index).match(/.$/u)?.[0] ?? ''
        const after = source.slice(match.index + match[0].length)
        const padded = /^[ \t]|[ \t]$/.test(inner) && !/[\p{L}\p{N}]/u.test(before)
        // CommonMark rejects punctuation-ended closers followed by a letter.
        // Relax that boundary only for CJK prose, leaving Latin intraword
        // delimiters and whitespace-only labels to the standard parser.
        const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
        const punctuationEnded = inner === trimmed && /\p{P}$/u.test(inner)
          && cjk.test(Array.from(after)[0] ?? '')
          && (!/[\p{L}\p{N}]/u.test(before) || cjk.test(before))
        if (!trimmed || (!padded && !punctuationEnded)) continue
        if (match.index > cursor) replacements.push(textToken(token.text.slice(cursor, match.index)))
        replacements.push({ type: 'strong', raw: match[0], text: trimmed,
          tokens: [textToken(trimmed)] } as Tokens.Strong)
        cursor = match.index + match[0].length
      }
      if (!replacements.length) continue
      if (cursor < token.text.length) replacements.push(textToken(token.text.slice(cursor)))
      tokens.splice(i, 1, ...replacements)
      i += replacements.length - 1
    }
  }
  function textToken(text: string): Tokens.Text {
    return { type: 'text', raw: text, text, escaped: false }
  }
  return { hooks: { processAllTokens(tokens) { repair(tokens); return tokens } } }
}
