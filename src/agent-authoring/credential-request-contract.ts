export interface CredentialRequest {
  id: string
  projectId: string
  sessionId: string
  secretRef: string
  purpose: string
  createdAt: string
  replacesExisting: boolean
}

export interface CredentialRequestResult {
  requestId: string
  secretRef: string
  status: 'saved' | 'cancelled'
}

export class CredentialRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 409 | 503 | 500,
    message: string,
  ) {
    super(message)
    this.name = 'CredentialRequestError'
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const secretRef = /^[a-z][a-z0-9_-]{0,63}$/
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
}

/** Renderer-safe metadata parser: never accepts or projects a credential value. */
export function parseCredentialRequest(value: unknown, expectedProjectId?: string): CredentialRequest {
  try {
    if (!objectWithKeys(value, ['id', 'projectId', 'sessionId', 'secretRef', 'purpose', 'createdAt', 'replacesExisting'])) throw new Error()
    const { id, projectId, sessionId, secretRef: ref, purpose, createdAt, replacesExisting } = value
    if (typeof id !== 'string' || !uuid.test(id) ||
      typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200 ||
      (expectedProjectId !== undefined && projectId !== expectedProjectId) ||
      typeof sessionId !== 'string' || !/^web:[^\x00-\x20\x7f]{1,500}$/.test(sessionId) || typeof ref !== 'string' || !secretRef.test(ref) ||
      typeof purpose !== 'string' || purpose.length === 0 || purpose.length > 500 || purpose.trim() !== purpose ||
      typeof createdAt !== 'string' || createdAt.length > 40 || !iso.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) ||
      typeof replacesExisting !== 'boolean') throw new Error()
    return { id, projectId, sessionId, secretRef: ref, purpose, createdAt, replacesExisting }
  } catch {
    throw new CredentialRequestError('invalid_request_metadata', 400, 'Invalid credential request metadata.')
  }
}

export function parseCredentialRequestResult(value: unknown): CredentialRequestResult {
  try {
    if (!objectWithKeys(value, ['requestId', 'secretRef', 'status'])) throw new Error()
    const { requestId, secretRef: ref, status } = value
    if (typeof requestId !== 'string' || !uuid.test(requestId) ||
      typeof ref !== 'string' || !secretRef.test(ref) ||
      (status !== 'saved' && status !== 'cancelled')) throw new Error()
    return { requestId, secretRef: ref, status }
  } catch {
    throw new CredentialRequestError('invalid_request_result', 400, 'Invalid credential request result.')
  }
}
