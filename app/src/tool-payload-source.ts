/** Separate read-tool pagination metadata from code without changing copyable text.
 * Only recognize the generated footer at the end, never arbitrary bracketed code. */
export function splitToolPayloadSource(source: string): { code: string; footer: string } {
  const match = /\r?\n\r?\n\[truncated: showing lines \d+[–-]\d+ of \d+(?: — use offset=\d+ to read more|; use offset=\d+ to continue)\]$/.exec(source)
  return match ? { code: source.slice(0, match.index), footer: match[0] } : { code: source, footer: '' }
}
