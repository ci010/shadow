import { loadPairConnection, parsePairArguments } from './web-pairing-cli.ts'
import { mobilePublicOrigin } from '../gateway/mobile-access.ts'

export async function manageMobileAccess(
  connection: { apiBase: string; token: string },
  action: { kind: 'pair' | 'list' } | { kind: 'revoke'; id: string },
  request: typeof fetch = fetch,
): Promise<string> {
  try {
    const url = new URL(connection.apiBase)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[A-Za-z0-9_-]{43,256}$/.test(connection.token)) throw new Error('Invalid local connection')
    if (action.kind === 'revoke' && !/^[a-f0-9-]{36}$/.test(action.id)) throw new Error('Invalid session ID')
    const suffix = action.kind === 'pair' ? 'mobile-pairing'
      : `mobile-sessions${action.kind === 'revoke' ? `/${action.id}` : ''}`
    const response = await request(`${url.origin}/local/v1/${suffix}`, {
      method: action.kind === 'pair' ? 'POST' : action.kind === 'list' ? 'GET' : 'DELETE',
      headers: { Authorization: `Bearer ${connection.token}` },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (action.kind === 'revoke' && response.status === 204) return `Revoked mobile session ${action.id}.\n`
    if (!response.ok || !response.body) throw new Error('Mobile access request failed')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > 16_384) throw new Error('Oversized mobile access response')
        chunks.push(part.value)
      }
    } finally { await reader.cancel() }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.includes(connection.token)) throw new Error('Invalid mobile access response')
    const result: unknown = JSON.parse(text)
    if (!result || typeof result !== 'object' || !('version' in result) || result.version !== 1) {
      throw new Error('Invalid mobile access response')
    }
    if (action.kind === 'pair') {
      if (!('url' in result) || typeof result.url !== 'string'
        || !('code' in result) || typeof result.code !== 'string' || !/^(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/.test(result.code)
        || !('expiresAt' in result) || typeof result.expiresAt !== 'string'
        || !validExpiry(result.expiresAt, 5 * 60_000)) throw new Error('Invalid mobile pairing response')
      return `Main HTTPS address: ${mobilePublicOrigin(result.url)}\nOne-use mobile pairing code: ${result.code}\nExpires: ${result.expiresAt}\nThis grants owner access to Main's application APIs, not device or runtime control.\n`
    }
    if (!('sessions' in result) || !Array.isArray(result.sessions) || result.sessions.length > 32) throw new Error('Invalid session list')
    const lines = result.sessions.map((session: unknown) => {
      if (!session || typeof session !== 'object' || !('id' in session) || typeof session.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(session.id) || !('expiresAt' in session)
        || typeof session.expiresAt !== 'string' || !validExpiry(session.expiresAt, 12 * 60 * 60_000)) {
        throw new Error('Invalid mobile session')
      }
      return `${session.id}  expires ${session.expiresAt}`
    })
    return lines.length ? `${lines.join('\n')}\n` : 'No active mobile sessions.\n'
  } catch {
    throw new Error('Could not manage mobile access. Check Main readiness, the protected launch credential, and SHADOW_MOBILE_ORIGIN. No credentials or response bodies are displayed.')
  }
}

function validExpiry(value: string, ttl: number): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && time > Date.now() && time <= Date.now() + ttl + 5000
}

export async function runMobilePair(args: readonly string[], output: (text: string) => void = console.log): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output([
      'pnpm mobile:pair [--list | --revoke <session-id>] --connection <absolute protected descriptor>',
      'pnpm mobile:pair [--list | --revoke <session-id>] --url http://127.0.0.1:<port> --credential-file <absolute protected file>',
      'Configure SHADOW_MOBILE_ORIGIN and a TLS reverse proxy before pairing.',
      'Credentials are read from protected files, never command-line values.',
    ].join('\n'))
    return
  }
  let action: { kind: 'pair' | 'list' } | { kind: 'revoke'; id: string } = { kind: 'pair' }
  if (args[0] === '--list') { action = { kind: 'list' }; args = args.slice(1) }
  else if (args[0] === '--revoke') { action = { kind: 'revoke', id: args[1] ?? '' }; args = args.slice(2) }
  const connection = await loadPairConnection(parsePairArguments(args))
  output(await manageMobileAccess(connection, action))
}
