import type { Context, Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from './contracts.ts'
import type {
  ApprovalV1,
  DeviceAuthenticationV1,
  InMemoryPairingNodeRegistry,
} from './registry.ts'

export interface NodeAdministrationApiOptions {
  readonly registry: InMemoryPairingNodeRegistry
  readonly authorize: (request: Request) => boolean | Promise<boolean>
  readonly approve: (
    approval: ApprovalV1,
    now: Date,
  ) => Promise<DeviceAuthenticationV1>
  readonly revoke: (nodeId: string, now: Date) => Promise<void>
  readonly now?: () => Date
  readonly maxBodyBytes?: number
}

export function nodeAdministrationApiPlugin(
  options: NodeAdministrationApiOptions,
): GatewayPlugin {
  const now = options.now ?? (() => new Date())
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('maxBodyBytes must be a positive safe integer')
  }
  return (app: Hono) => {
    app.post('/nodes/v1/:nodeId/revoke', async (context) => {
      if (!await options.authorize(context.req.raw)) return unauthorized(context)
      const nodeId = context.req.param('nodeId')
      if (!isClusterIdentifier(nodeId)) return context.json({ error: 'invalid_node_id' }, 400)
      if (!options.registry.listNodes().some(node => node.nodeId === nodeId)) {
        return context.json({ error: 'node_not_found' }, 404)
      }
      try {
        await options.revoke(nodeId, now())
        return context.json({ version: 1, nodeId, state: 'revoked' }, 200, { 'Cache-Control': 'no-store' })
      } catch (error) {
        console.error('[cluster] Device removal could not be completed', error)
        return context.json({ error: 'node_revocation_failed' }, 503, { 'Cache-Control': 'no-store' })
      }
    })

    app.get('/nodes/v1/pending', async (context) => {
      if (!await options.authorize(context.req.raw)) return unauthorized(context)
      return context.json({
        version: 1,
        pending: options.registry.getPending().map((record) => ({
          version: 1,
          pendingId: record.pendingId,
          deviceId: record.deviceId,
          nodeId: record.nodeId,
          credentialId: record.credentialId,
          deviceIdentityFingerprint: record.deviceIdentityFingerprint,
          displayName: record.displayName,
          requestedAt: record.requestedAt,
        })),
      }, 200, { 'Cache-Control': 'no-store' })
    })

    app.post('/nodes/v1/pending/:pendingId/approve', async (context) => {
      if (!await options.authorize(context.req.raw)) return unauthorized(context)
      if (
        context.req.header('Content-Type')?.split(';', 1)[0].trim()
          .toLowerCase() !== 'application/json'
      ) {
        return context.json({ error: 'content_type_required' }, 415)
      }
      try {
        const pendingId = context.req.param('pendingId')
        if (!isClusterIdentifier(pendingId)) throw new TypeError('invalid pendingId')
        const pending = options.registry.getPending().find((record) =>
          record.pendingId === pendingId
        )
        if (!pending) return context.json({ error: 'pending_not_found' }, 404)
        const request = parseApproval(
          JSON.parse(await readBoundedBody(context.req.raw, maxBodyBytes)),
        )
        const credentialId = pending.credentialId ?? request.credentialId
        if (!credentialId) {
          return context.json({ error: 'credential_id_required' }, 409)
        }
        if (
          request.credentialId !== undefined &&
          request.credentialId !== credentialId
        ) {
          return context.json({ error: 'credential_mismatch' }, 409)
        }
        const authentication = await options.approve({
          pendingId,
          expectedDeviceIdentityFingerprint:
            request.expectedDeviceIdentityFingerprint,
          credentialId,
        }, now())
        return context.json({ version: 1, ...authentication }, 200, {
          'Cache-Control': 'no-store',
        })
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return context.json({ error: 'body_too_large' }, 413)
        }
        return context.json({ error: 'invalid_approval' }, 400)
      }
    })
  }
}

function unauthorized(context: Context): Response {
  return context.json({ error: 'unauthorized' }, 401, {
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Bearer',
  })
}

function parseApproval(value: unknown): {
  expectedDeviceIdentityFingerprint: string
  credentialId?: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('approval must be an object')
  }
  const candidate = value as Record<string, unknown>
  const allowed = new Set([
    'version',
    'expectedDeviceIdentityFingerprint',
    'credentialId',
  ])
  if (
    candidate.version !== 1 ||
    Object.keys(candidate).some((key) => !allowed.has(key)) ||
    typeof candidate.expectedDeviceIdentityFingerprint !== 'string' ||
    candidate.expectedDeviceIdentityFingerprint.length === 0 ||
    (
      candidate.credentialId !== undefined &&
      !isClusterIdentifier(candidate.credentialId)
    )
  ) throw new TypeError('approval is invalid')
  return {
    expectedDeviceIdentityFingerprint:
      candidate.expectedDeviceIdentityFingerprint,
    ...(candidate.credentialId === undefined
      ? {}
      : { credentialId: candidate.credentialId as string }),
  }
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new BodyTooLargeError()
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > maxBytes) throw new BodyTooLargeError()
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}