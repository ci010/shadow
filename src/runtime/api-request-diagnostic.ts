/** Fixed endpoint identities only: never retain project/session IDs or queries. */
export function diagnosticEndpoint(path: string): string | undefined {
  path = path.replace(/^\/projects\/[^/]+(?=\/api\/)/, '')
  if (path === '/api/sessions/graph') return 'sessions/graph'
  if (path === '/api/sessions/summary') return 'sessions/summary'
  if (/^\/api\/sessions\/[^/]+\/details$/.test(path)) return 'sessions/:id/details'
  return /^\/api\/(projects|service-groups|agent-types|background-tasks)(?:\/|$)/.exec(path)?.[1]
}

export const DIAGNOSTIC_ID_HEADER = 'X-Shadow-Request-Id'
export function diagnosticId(value: string | null): string | undefined {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value) ? value : undefined
}
