import { parse as parseYaml } from 'yaml'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the parsed frontmatter object and the body text after `---`.
 */
export function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const normalised = content.replace(/\r\n/g, '\n')
  const match = normalised.match(FRONTMATTER_RE)

  if (!match) {
    return { frontmatter: {}, body: normalised }
  }

  const raw = parseYaml(match[1])
  const frontmatter = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {}

  return { frontmatter, body: match[2] }
}
