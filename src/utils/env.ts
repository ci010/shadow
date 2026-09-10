import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/**
 * Parse a .env file into a key-value record.
 * Supports: `KEY=VALUE`, `export KEY=VALUE`, quoted values, # comments.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const stripped = line.startsWith('export ')
      ? line.slice(7).trimStart()
      : line
    const eq = stripped.indexOf('=')
    if (eq === -1) continue
    const key = stripped.slice(0, eq).trim()
    if (!key) continue
    let value = stripped.slice(eq + 1)
    // Strip inline comment (only when value is unquoted)
    if (value.length > 0 && value[0] !== '"' && value[0] !== "'") {
      const comment = value.indexOf(' #')
      if (comment !== -1) value = value.slice(0, comment)
    }
    value = value.trim()
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/** Load the .env file from `dir` if it exists, or return an empty record. */
export async function loadDotEnv(dir: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(dir, '.env'), 'utf8')
    return parseDotEnv(content)
  } catch {
    return {}
  }
}
