/**
 * Utilities for parsing `MEDIA:<path-or-url>` directives out of agent-generated text.
 *
 * The agent (or any tool) can embed attachments in its reply by placing one or
 * more directives at the end of a response line:
 *
 *   MEDIA:<path-or-url>
 *
 * Paths may contain spaces, and a label may precede the directive. Markers are
 * stripped from the visible text and returned separately so the channel can
 * forward them as images / file attachments.
 *
 * Example input:
 *   Here's the screenshot.
 *   MEDIA:uploads/screenshot.png
 *   MEDIA:https://example.com/chart.png
 *
 * Result:
 *   text  = "Here's the screenshot."
 *   media = ["uploads/screenshot.png", "https://example.com/chart.png"]
 */

export interface ParsedContent {
  /** Text with MEDIA: directives outside code removed. */
  text: string
  /** Ordered list of media paths or URLs extracted from the content, or undefined if none. */
  media: string[] | undefined
}

/**
 * Parse `MEDIA:` directives out of `raw` content.
 * A directive consumes the rest of its line; code examples are never attachments.
 */
export function parseMediaFromContent(raw: string): ParsedContent {
  const media = new Set<string>()
  const text = raw.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\2|(?<![\p{L}\p{N}_])MEDIA:[ \t]*([^\r\n]+)/gu,
    (match, _fence: string | undefined, _ticks: string | undefined, value: string | undefined) => {
      if (value === undefined) return match
      let path = value.trim()
      if (/^(["'`]).*\1$/.test(path)) path = path.slice(1, -1).trim()
      if (!path) return match
      media.add(path)
      return ''
    },
  ).replace(/^\s*\n|\n\s*$/g, '')
  return { text, media: media.size ? [...media] : undefined }
}
