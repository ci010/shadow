import type { Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from './contracts.ts'
import {
  DeviceChallengeAuthority,
  nodeWebSocketAudience,
} from './device-challenge.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'

export interface DeviceChallengeApiOptions {
  readonly authority: DeviceChallengeAuthority
  readonly clientKey: (request: Request) => string
  readonly now?: () => Date
  readonly maxBodyBytes?: number
  readonly requestsPerMinute?: number
}

interface ClientWindow {
  startedAt: number
  requests: number
}

export function deviceChallengeApiPlugin(
  options: DeviceChallengeApiOptions,
): GatewayPlugin {
  const now = options.now ?? (() => new Date())
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? 1024,
    'maxBodyBytes',
  )
  const requestsPerMinute = positiveInteger(
    options.requestsPerMinute ?? 20,
    'requestsPerMinute',
  )
  const clients = new Map<string, ClientWindow>()

  return (app: Hono) => {
    app.post('/cluster/v1/challenges', async (context) => {
      const requestTime = now()
      const client = options.clientKey(context.req.raw).trim()
      if (!client) {
        return context.json({ error: 'client_identity_unavailable' }, 503)
      }
      if (!consume(clients, client, requestTime, requestsPerMinute)) {
        return context.json({ error: 'rate_limited' }, 429, {
          'Cache-Control': 'no-store',
          'Retry-After': '60',
        })
      }
      if (
        context.req.header('Content-Type')?.split(';', 1)[0].trim()
          .toLowerCase() !== 'application/json'
      ) {
        return context.json({ error: 'content_type_required' }, 415)
      }

      let authentication: DeviceAuthenticationV1
      try {
        authentication = parseAuthentication(
          JSON.parse(await readBoundedBody(context.req.raw, maxBodyBytes)),
        )
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 400
        const code = error instanceof BodyTooLargeError
          ? 'body_too_large'
          : 'invalid_authentication'
        return context.json({ error: code }, status)
      }

      try {
        const challenge = options.authority.issue(
          authentication,
          nodeWebSocketAudience(context.req.url),
          requestTime,
        )
        return context.json(challenge, 201, { 'Cache-Control': 'no-store' })
      } catch {
        return context.json({ error: 'credential_not_available' }, 404, {
          'Cache-Control': 'no-store',
        })
      }
    })
  }
}

function parseAuthentication(value: unknown): DeviceAuthenticationV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('authentication must be an object')
  }
  const candidate = value as Record<string, unknown>
  const fields = ['version', 'deviceId', 'nodeId', 'credentialId']
  if (
    candidate.version !== 1 ||
    Object.keys(candidate).length !== fields.length ||
    fields.some((field) => !(field in candidate))
  ) throw new TypeError('authentication schema is invalid')
  for (const field of fields.slice(1)) {
    if (!isClusterIdentifier(candidate[field])) {
      throw new TypeError(`${field} is invalid`)
    }
  }
  return {
    deviceId: candidate.deviceId as string,
    nodeId: candidate.nodeId as string,
    credentialId: candidate.credentialId as string,
  }
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new BodyTooLargeError()
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new BodyTooLargeError()
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function consume(
  clients: Map<string, ClientWindow>,
  client: string,
  now: Date,
  limit: number,
): boolean {
  const timestamp = now.getTime()
  for (const [key, window] of clients) {
    if (timestamp - window.startedAt >= 60_000) clients.delete(key)
  }
  const window = clients.get(client)
  if (!window) {
    clients.set(client, { startedAt: timestamp, requests: 1 })
    return true
  }
  if (window.requests >= limit) return false
  window.requests++
  return true
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}
