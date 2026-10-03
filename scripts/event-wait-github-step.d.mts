export interface StepIdentity {
  requestId: string
  repository: string
  sha: string
  runId: number
}
export interface UrlSignal {
  version: number
  requestId: string
  ciRunId: number
  cdRunId: number
  deploymentId: number
  url: string
  printedAt: string
  deadlineAt: string
}
export interface UrlStepResult extends UrlSignal {
  passed: boolean
  elapsedMs: number
  observedAckAt?: string
  ackStatusId?: number
  error?: string
}
export const TEST_ENVIRONMENT: string
export const uuidPattern: RegExp
export function stepIdentity(env: NodeJS.ProcessEnv): StepIdentity
export function createBuildReceipt(root: string, identity: StepIdentity): Promise<StepIdentity & {
  version: number
  files: Array<{ path: string; sha256: string }>
}>
export function verifyBuildReceipt(root: string, expected: StepIdentity): Promise<StepIdentity & { files: number }>
export function runUrlStep(options: {
  identity: StepIdentity
  ciRunId: number
  timeoutMs: number
  request(path: string, method?: 'GET' | 'POST' | 'PATCH', body?: Record<string, unknown>): Promise<unknown>
  log?: (text: string) => void
  now?: () => number
  monotonic?: () => number
  pollMs?: number
}): Promise<UrlStepResult>
