/** Canonicalize JSON string escapes without rewriting numbers or nested string values. */
export function readableMcpText(text: string): string {
  if (!/^\s*[\[{]/.test(text) || !/\\u[0-9a-f]{4}/i.test(text)) return text
  try {
    JSON.parse(text)
  } catch {
    // MCP text need not be JSON. Leave prose and incomplete JSON untouched.
    return text
  }
  return text.replace(/"(?:\\.|[^"\\])*"/g, token =>
    /\\u[0-9a-f]{4}/i.test(token) ? JSON.stringify(JSON.parse(token)) : token)
}
