import type { Context, Hono } from 'hono'
import type { GatewayPlugin } from './types.ts'
import type {
  LocalApprovalGrantScope,
  LocalApprovalService,
} from '../execution/local-approval.ts'

export interface LocalApprovalApiOptions {
  readonly service: LocalApprovalService
  readonly maxBodyBytes?: number
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024

export function localApprovalApiPlugin(
  options: LocalApprovalApiOptions,
): GatewayPlugin {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('maxBodyBytes must be a positive safe integer')
  }
  return (app: Hono) => {
    app.get('/local/v1/approvals', (context) => {
      return context.json(
        {
          version: 1,
          pending: options.service.listPending(),
          grants: options.service.listGrants(),
        },
        200,
        { 'Cache-Control': 'no-store' },
      )
    })

    app.post('/local/v1/approvals/:approvalId/decision', async (context) => {
      try {
        requireJson(context.req.raw)
        const approvalId = parseApprovalId(context.req.param('approvalId'))
        const decision = parseDecision(
          JSON.parse(await readBoundedBody(context.req.raw, maxBodyBytes)),
        )
        const accepted = decision.decision === 'deny'
          ? options.service.deny(approvalId)
          : options.service.approve(approvalId, decision.scope)
        if (!accepted) {
          return context.json(
            { error: 'approval_not_found_or_scope_denied' },
            404,
            {
              'Cache-Control': 'no-store',
            },
          )
        }
        return context.json({ version: 1, accepted: true }, 200, {
          'Cache-Control': 'no-store',
        })
      } catch (error) {
        return invalidRequest(context, error)
      }
    })

    app.post('/local/v1/grants/revoke', async (context) => {
      try {
        requireJson(context.req.raw)
        const request = parseRevocation(
          JSON.parse(await readBoundedBody(context.req.raw, maxBodyBytes)),
        )
        const revoked = options.service.revoke(request)
        return context.json({ version: 1, revoked }, 200, {
          'Cache-Control': 'no-store',
        })
      } catch (error) {
        return invalidRequest(context, error)
      }
    })
  }
}

function parseDecision(value: unknown):
  | { decision: 'deny' }
  | { decision: 'approve'; scope: LocalApprovalGrantScope } {
  const candidate = strictRecord(value, ['version', 'decision', 'scope'])
  if (candidate.version !== 1) throw new InvalidRequestError()
  if (candidate.decision === 'deny' && candidate.scope === undefined) {
    return { decision: 'deny' }
  }
  if (
    candidate.decision === 'approve' &&
    (candidate.scope === 'once' || candidate.scope === 'session' ||
      candidate.scope === 'capability')
  ) return { decision: 'approve', scope: candidate.scope }
  throw new InvalidRequestError()
}

function parseRevocation(value: unknown): {
  capabilityId: string
  operation?: string
  sessionId?: string
} {
  const candidate = strictRecord(value, [
    'version',
    'capabilityId',
    'operation',
    'sessionId',
  ])
  if (candidate.version !== 1) throw new InvalidRequestError()
  const capabilityId = boundedString(candidate.capabilityId)
  const operation = optionalBoundedString(candidate.operation)
  const sessionId = optionalBoundedString(candidate.sessionId)
  return {
    capabilityId,
    ...(operation === undefined ? {} : { operation }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function strictRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError()
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !allowed.includes(key))) {
    throw new InvalidRequestError()
  }
  return candidate
}

function parseApprovalId(value: string): string {
  return boundedString(value)
}

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new InvalidRequestError()
  }
  return value
}

function optionalBoundedString(value: unknown): string | undefined {
  return value === undefined ? undefined : boundedString(value)
}

function requireJson(request: Request): void {
  if (
    request.headers.get('Content-Type')?.split(';', 1)[0].trim()
      .toLowerCase() !== 'application/json'
  ) throw new ContentTypeError()
}

class InvalidRequestError extends Error {}
class ContentTypeError extends Error {}
class BodyTooLargeError extends Error {}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new BodyTooLargeError()
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > maxBytes) throw new BodyTooLargeError()
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function invalidRequest(
  context: Context,
  error: unknown,
): Response {
  if (error instanceof ContentTypeError) {
    return context.json({ error: 'content_type_required' }, 415, {
      'Cache-Control': 'no-store',
    })
  }
  if (error instanceof BodyTooLargeError) {
    return context.json({ error: 'body_too_large' }, 413, {
      'Cache-Control': 'no-store',
    })
  }
  return context.json({ error: 'invalid_request' }, 400, {
    'Cache-Control': 'no-store',
  })
}
