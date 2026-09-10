/**
 * Utilities for parsing `MEDIA:<path-or-url>` directives out of agent-generated text.
 *
 * The agent (or any tool) can embed attachments in its reply by placing one or
 * more lines of the form:
 *
 *   MEDIA:<path-or-url>
 *
 * on their own line (no leading/trailing spaces on that line).  The lines are
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
  /** Text with all MEDIA: lines removed and leading/trailing blank lines trimmed. */
  text: string
  /** Ordered list of media paths or URLs extracted from the content, or undefined if none. */
  media: string[] | undefined
}

/** Matches a single `MEDIA:<value>` line with no surrounding whitespace. */
const MEDIA_LINE_RE = /^MEDIA:(\S+)$/

/**
 * Parse `MEDIA:` directives out of `raw` content.
 *
 * Lines matching `MEDIA:<value>` (exact — no leading spaces) are extracted
 * into `media`; all other lines form the returned `text`.
 */
export function parseMediaFromContent(raw: string): ParsedContent {
  const media: string[] = []
  const textLines: string[] = []

  for (const line of raw.split('\n')) {
    const m = MEDIA_LINE_RE.exec(line)
    if (m) {
      media.push(m[1])
    } else {
      textLines.push(line)
    }
  }

  // Trim leading/trailing blank lines left after removing MEDIA: entries
  const text = textLines.join('\n').replace(/^\s*\n|\n\s*$/g, '')

  return { text, media: media.length > 0 ? media : undefined }
}
