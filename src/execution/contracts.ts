export type JobApprovalV1 = 'none' | 'local-required'

export interface JobRequestV1 {
  version: 1
  jobId: string
  idempotencyKey: string
  sessionId: string
  turnId: string
  nodeId: string
  capabilityId: string
  operation: string
  args: unknown
  createdAt: string
  deadlineAt: string
  approval: JobApprovalV1
}

export type JobStateV1 =
  | 'accepted'
  | 'awaiting-approval'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled'

export type JobTerminalStateV1 = Extract<
  JobStateV1,
  'completed' | 'failed' | 'rejected' | 'expired' | 'cancelled'
>

export interface JobReasonV1 {
  code: string
  message: string
  retryable: boolean
}

export interface ExecutionReceiptV1 {
  version: 1
  jobId: string
  nodeId: string
  state: JobTerminalStateV1
  startedAt?: string
  finishedAt: string
  pid?: number
  exitCode?: number
  signal?: string
  reason?: JobReasonV1
}

interface JobEventBaseV1 {
  version: 1
  jobId: string
  sequence: number
  timestamp: string
}

export type JobEventV1 =
  | (JobEventBaseV1 & { type: 'accepted' })
  | (JobEventBaseV1 & { type: 'awaiting-approval' })
  | (JobEventBaseV1 & { type: 'started'; pid: number })
  | (JobEventBaseV1 & { type: 'stdout' | 'stderr'; chunk: string })
  | (JobEventBaseV1 & {
    type: 'artifact-ready'
    artifactId: string
    mediaType: string
    size: number
  })
  | (JobEventBaseV1 & {
    type: 'cancel-acknowledged'
    receipt: ExecutionReceiptV1
  })
  | (JobEventBaseV1 & {
    type: 'completed' | 'failed' | 'rejected' | 'expired'
    receipt: ExecutionReceiptV1
  })

export interface JobStatusV1 {
  version: 1
  jobId: string
  state: JobStateV1
  lastSequence: number
  updatedAt: string
  receipt?: ExecutionReceiptV1
}

export interface CancelReceiptV1 {
  version: 1
  jobId: string
  outcome: 'requested' | 'already-terminal' | 'not-found'
  timestamp: string
  status: JobStatusV1 | null
}

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; errors: string[] }

const JOB_STATES = new Set<JobStateV1>([
  'accepted',
  'awaiting-approval',
  'running',
  'cancelling',
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
])
const TERMINAL_STATES = new Set<JobTerminalStateV1>([
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
])
const EVENT_TYPES = new Set<JobEventV1['type']>([
  'accepted',
  'awaiting-approval',
  'started',
  'stdout',
  'stderr',
  'artifact-ready',
  'cancel-acknowledged',
  'completed',
  'failed',
  'rejected',
  'expired',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: string[],
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`unknown field: ${key}`)
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    errors.push(`${key} must be a non-empty string`)
  }
}

function requireInteger(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
    errors.push(`${key} must be a non-negative safe integer`)
  }
}

function requireTimestamp(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  requireString(value, key, errors)
  if (typeof value[key] === 'string' && Number.isNaN(Date.parse(value[key]))) {
    errors.push(`${key} must be an ISO timestamp`)
  }
}

function result<T>(errors: string[], value: T): ValidationResult<T> {
  return errors.length === 0
    ? { success: true, value }
    : { success: false, errors }
}

export function validateJobRequestV1(value: unknown): ValidationResult<JobRequestV1> {
  if (!isRecord(value)) return { success: false, errors: ['request must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(value, [
    'version',
    'jobId',
    'idempotencyKey',
    'sessionId',
    'turnId',
    'nodeId',
    'capabilityId',
    'operation',
    'args',
    'createdAt',
    'deadlineAt',
    'approval',
  ], errors)
  if (value.version !== 1) errors.push('version must be 1')
  for (
    const key of [
      'jobId',
      'idempotencyKey',
      'sessionId',
      'turnId',
      'nodeId',
      'capabilityId',
      'operation',
    ]
  ) requireString(value, key, errors)
  if (!Object.hasOwn(value, 'args')) errors.push('args is required')
  requireTimestamp(value, 'createdAt', errors)
  requireTimestamp(value, 'deadlineAt', errors)
  if (value.approval !== 'none' && value.approval !== 'local-required') {
    errors.push('approval must be none or local-required')
  }
  if (
    typeof value.createdAt === 'string' && typeof value.deadlineAt === 'string' &&
    Date.parse(value.deadlineAt) < Date.parse(value.createdAt)
  ) errors.push('deadlineAt must not precede createdAt')
  return result(errors, value as unknown as JobRequestV1)
}

function validateReason(value: unknown, errors: string[]): value is JobReasonV1 {
  if (!isRecord(value)) {
    errors.push('reason must be an object')
    return false
  }
  hasOnlyKeys(value, ['code', 'message', 'retryable'], errors)
  requireString(value, 'code', errors)
  requireString(value, 'message', errors)
  if (typeof value.retryable !== 'boolean') errors.push('reason.retryable must be boolean')
  return errors.length === 0
}

export function validateExecutionReceiptV1(
  value: unknown,
): ValidationResult<ExecutionReceiptV1> {
  if (!isRecord(value)) return { success: false, errors: ['receipt must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(value, [
    'version',
    'jobId',
    'nodeId',
    'state',
    'startedAt',
    'finishedAt',
    'pid',
    'exitCode',
    'signal',
    'reason',
  ], errors)
  if (value.version !== 1) errors.push('version must be 1')
  requireString(value, 'jobId', errors)
  requireString(value, 'nodeId', errors)
  if (!TERMINAL_STATES.has(value.state as JobTerminalStateV1)) {
    errors.push('receipt.state must be terminal')
  }
  if (value.startedAt !== undefined) requireTimestamp(value, 'startedAt', errors)
  requireTimestamp(value, 'finishedAt', errors)
  if (value.pid !== undefined) requireInteger(value, 'pid', errors)
  if (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) {
    errors.push('exitCode must be a safe integer')
  }
  if (value.signal !== undefined && typeof value.signal !== 'string') {
    errors.push('signal must be a string')
  }
  if (value.reason !== undefined) validateReason(value.reason, errors)
  return result(errors, value as unknown as ExecutionReceiptV1)
}

export function validateJobEventV1(value: unknown): ValidationResult<JobEventV1> {
  if (!isRecord(value)) return { success: false, errors: ['event must be an object'] }
  const errors: string[] = []
  const type = value.type as JobEventV1['type']
  const specificKeys: Record<JobEventV1['type'], string[]> = {
    accepted: [],
    'awaiting-approval': [],
    started: ['pid'],
    stdout: ['chunk'],
    stderr: ['chunk'],
    'artifact-ready': ['artifactId', 'mediaType', 'size'],
    'cancel-acknowledged': ['receipt'],
    completed: ['receipt'],
    failed: ['receipt'],
    rejected: ['receipt'],
    expired: ['receipt'],
  }
  if (!EVENT_TYPES.has(type)) errors.push('type is unsupported')
  hasOnlyKeys(
    value,
    ['version', 'jobId', 'sequence', 'timestamp', 'type', ...(specificKeys[type] ?? [])],
    errors,
  )
  if (value.version !== 1) errors.push('version must be 1')
  requireString(value, 'jobId', errors)
  requireInteger(value, 'sequence', errors)
  requireTimestamp(value, 'timestamp', errors)
  if (type === 'started') requireInteger(value, 'pid', errors)
  if (type === 'stdout' || type === 'stderr') requireString(value, 'chunk', errors)
  if (type === 'artifact-ready') {
    requireString(value, 'artifactId', errors)
    requireString(value, 'mediaType', errors)
    requireInteger(value, 'size', errors)
  }
  if (
    type === 'cancel-acknowledged' || type === 'completed' || type === 'failed' ||
    type === 'rejected' || type === 'expired'
  ) {
    const receipt = validateExecutionReceiptV1(value.receipt)
    if (!receipt.success) errors.push(...receipt.errors.map((error) => `receipt.${error}`))
  }
  return result(errors, value as unknown as JobEventV1)
}

export function validateJobStatusV1(value: unknown): ValidationResult<JobStatusV1> {
  if (!isRecord(value)) return { success: false, errors: ['status must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(value, ['version', 'jobId', 'state', 'lastSequence', 'updatedAt', 'receipt'], errors)
  if (value.version !== 1) errors.push('version must be 1')
  requireString(value, 'jobId', errors)
  if (!JOB_STATES.has(value.state as JobStateV1)) errors.push('state is unsupported')
  requireInteger(value, 'lastSequence', errors)
  requireTimestamp(value, 'updatedAt', errors)
  if (value.receipt !== undefined) {
    const receipt = validateExecutionReceiptV1(value.receipt)
    if (!receipt.success) errors.push(...receipt.errors.map((error) => `receipt.${error}`))
  }
  return result(errors, value as unknown as JobStatusV1)
}

export function validateCancelReceiptV1(
  value: unknown,
): ValidationResult<CancelReceiptV1> {
  if (!isRecord(value)) return { success: false, errors: ['cancel receipt must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(value, ['version', 'jobId', 'outcome', 'timestamp', 'status'], errors)
  if (value.version !== 1) errors.push('version must be 1')
  requireString(value, 'jobId', errors)
  if (
    value.outcome !== 'requested' && value.outcome !== 'already-terminal' &&
    value.outcome !== 'not-found'
  ) errors.push('outcome is unsupported')
  requireTimestamp(value, 'timestamp', errors)
  if (value.status !== null) {
    const status = validateJobStatusV1(value.status)
    if (!status.success) errors.push(...status.errors.map((error) => `status.${error}`))
  }
  return result(errors, value as unknown as CancelReceiptV1)
}