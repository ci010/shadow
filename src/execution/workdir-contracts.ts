import type { ValidationResult } from './contracts.ts'

/** Supported implementation features, never Project permission or an independent capability. */
export interface ExecutionSupport {
  operations: string[]
  shell?: { shells: string[]; maxInputBytes?: number; maxDeadlineMs?: number }
}

/** Directory binding advertisement. The owning device alone knows its actual root. */
export interface WorkdirAdvertisement {
  version: 2
  nodeId: string
  workdirId: string
  displayName: string
  displayPath?: string
  online: boolean
  support: ExecutionSupport
}

export const EXECUTION_PROTOCOL_FEATURE = 'workdir-execution-v2'
export const IMPLEMENTED_OPERATIONS = [
  'process.execute', 'filesystem.read', 'filesystem.write', 'workdir.git.status',
  'workdir.git.diff', 'workdir.identity', 'workdir.process.execute',
  'workdir.process.execute-once', 'workdir.process.reconcile',
  'workdir.session.allocate', 'owner.folder.browse', 'owner.folder.select',
] as const
export const NODE_OPERATIONS = new Set(['process.execute', 'workdir.session.allocate', 'owner.folder.browse', 'owner.folder.select'])
const SHELL_OPERATIONS = new Set(['process.execute', 'workdir.process.execute', 'workdir.process.execute-once', 'workdir.process.reconcile'])
const SHELLS = ['cmd', 'sh', 'bash', 'git-bash', 'powershell', 'pwsh']
export const isExecutionIdentifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function keys(v: Record<string, unknown>, allowed: string[], errors: string[]) {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) errors.push(`unknown field: ${key}`)
}
function text(v: unknown, max: number) {
  return typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(v)
}
function result<T>(value: unknown, errors: string[]): ValidationResult<T> {
  return errors.length ? { success: false, errors } : { success: true, value: structuredClone(value) as T }
}
export function validateExecutionSupport(value: unknown, scope?: 'node' | 'workdir'): ValidationResult<ExecutionSupport> {
  if (!record(value)) return { success: false, errors: ['support must be an object'] }
  const errors: string[] = []
  keys(value, ['operations', 'shell'], errors)
  if (!Array.isArray(value.operations) || new Set(value.operations).size !== value.operations.length || value.operations.some(op => !IMPLEMENTED_OPERATIONS.includes(op))) errors.push('operations must be unique implemented operations')
  else if (scope && value.operations.some(op => NODE_OPERATIONS.has(op) !== (scope === 'node'))) errors.push('operation does not match directory/node addressing')
  if (value.shell !== undefined) {
    if (!record(value.shell)) errors.push('shell must be an object')
    else {
      keys(value.shell, ['shells', 'maxInputBytes', 'maxDeadlineMs'], errors)
      if (!Array.isArray(value.shell.shells) || !value.shell.shells.length || value.shell.shells.some(s => !SHELLS.includes(s)) || new Set(value.shell.shells).size !== value.shell.shells.length) errors.push('shells are invalid')
      for (const key of ['maxInputBytes', 'maxDeadlineMs']) if (value.shell[key] !== undefined && (!Number.isSafeInteger(value.shell[key]) || Number(value.shell[key]) < 1 || Number(value.shell[key]) > 16_777_216)) errors.push(`${key} is out of bounds`)
    }
  }
  return result(value, errors)
}
export function validateWorkdirAdvertisement(value: unknown): ValidationResult<WorkdirAdvertisement> {
  if (!record(value)) return { success: false, errors: ['workdir must be an object'] }
  const errors: string[] = []
  keys(value, ['version', 'nodeId', 'workdirId', 'displayName', 'displayPath', 'online', 'support'], errors)
  if (value.version !== 2) errors.push('workdir version must be 2; upgrade both peers')
  if (!isExecutionIdentifier(value.nodeId) || !isExecutionIdentifier(value.workdirId)) errors.push('workdir identifiers are invalid')
  if (!text(value.displayName, 256)) errors.push('displayName is invalid')
  if (value.displayPath !== undefined && !text(value.displayPath, 4096)) errors.push('displayPath is invalid')
  if (typeof value.online !== 'boolean') errors.push('online must be boolean')
  const support = validateExecutionSupport(value.support, 'workdir')
  if (!support.success) errors.push(...support.errors)
  return result(value, errors)
}
export class ExecutionAdmissionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ExecutionAdmissionError' }
}
export function assertExecutionProtocol(features: readonly string[] | undefined): void {
  if (!features?.includes(EXECUTION_PROTOCOL_FEATURE)) throw new ExecutionAdmissionError('execution-upgrade-required', 'Remote execution requires the workdir protocol. Upgrade both Main and Child; no downgrade is supported.')
}
/** Pure live support admission, before journal claims or side effects. */
export function assertExecutionSupported(request: { nodeId: string; workdirId?: string; operation: string; args: unknown; createdAt: string; deadlineAt: string }, workdirs: readonly WorkdirAdvertisement[], nodeSupport: ExecutionSupport): void {
  if (!IMPLEMENTED_OPERATIONS.includes(request.operation as typeof IMPLEMENTED_OPERATIONS[number])) throw new ExecutionAdmissionError('unsupported-operation', `Unsupported operation: ${request.operation}`)
  const nodeOperation = NODE_OPERATIONS.has(request.operation)
  if (nodeOperation !== (request.workdirId === undefined)) throw new ExecutionAdmissionError('invalid-address', 'Directory operations require workdirId; node services forbid it')
  const workdir = request.workdirId === undefined ? undefined : workdirs.find(w => w.nodeId === request.nodeId && w.workdirId === request.workdirId && w.online)
  if (!nodeOperation && !workdir) throw new ExecutionAdmissionError('workdir-unavailable', 'The exact workdir is missing, offline or withdrawn')
  const support = workdir?.support ?? nodeSupport
  const valid = validateExecutionSupport(support, nodeOperation ? 'node' : 'workdir')
  if (!valid.success || !support.operations.includes(request.operation)) throw new ExecutionAdmissionError('unsupported-operation', 'No live support for this operation on the selected directory/device')
  const shell = SHELL_OPERATIONS.has(request.operation) ? support.shell : undefined
  const args = record(request.args) ? request.args : {}
  if (shell && ((shell.maxInputBytes && Buffer.byteLength(JSON.stringify(request.args) ?? '', 'utf8') > shell.maxInputBytes) ||
    (shell.maxDeadlineMs && Date.parse(request.deadlineAt) - Date.parse(request.createdAt) > shell.maxDeadlineMs) ||
    (args.shell !== undefined && !shell.shells.includes(String(args.shell))))) throw new ExecutionAdmissionError('operation-conditions-denied', 'Request exceeds shell support limits')
}
export function workdirIdOf(request: { workdirId?: string }): string {
  if (!request.workdirId) throw new ExecutionAdmissionError('workdir-required', 'This operation requires a directory workdirId')
  return request.workdirId
}
