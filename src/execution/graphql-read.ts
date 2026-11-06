/** Conservative fixed-query allowlist policy; intentionally not a general GraphQL parser. */
export function assertReadQuery(query: string): void {
  if (!/^query\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*)?\(/.test(query) || /\b(mutation|subscription|query)\b/i.test(query.replace(/^query\b/, '')) || query.includes('#')) {
    throw new Error('Only one explicit parameterized read query without comments is supported')
  }
}
