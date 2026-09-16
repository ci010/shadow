import type { LearningPipelineStatus, LearningStatus } from '../../src/agent/learning/service.ts'
import { organizationJson } from './organizations.ts'
import { isRecord } from './projects-sidebar.ts'

export type { LearningPipelineStatus, LearningStatus }
export const learningPipelines = [
  { id: 'reflector', label: 'Self-reflection' },
  { id: 'encapsulator', label: 'Skill encapsulation' },
  { id: 'soulReflector', label: 'Identity reflection' },
] as const

function parsePipeline(value: unknown): LearningPipelineStatus {
  if (!isRecord(value) || typeof value.intervalMs !== 'number' || !Number.isSafeInteger(value.intervalMs)
    || value.intervalMs < 1 || value.intervalMs > 2_147_483_647
    || typeof value.pending !== 'boolean' || typeof value.dispatching !== 'boolean'
    || (value.lastError !== undefined && typeof value.lastError !== 'string')) {
    throw new Error('Main returned invalid learning pipeline status. Refresh to retry.')
  }
  const timestamps: Partial<Pick<LearningPipelineStatus, 'lastStartedAt' | 'lastCheckedAt' | 'lastDispatchedAt'>> = {}
  for (const key of ['lastStartedAt', 'lastCheckedAt', 'lastDispatchedAt'] as const) {
    const timestamp = value[key]
    if (timestamp === undefined) continue
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error('Main returned an invalid learning timestamp. Refresh to retry.')
    }
    timestamps[key] = timestamp
  }
  return {
    intervalMs: value.intervalMs, pending: value.pending, dispatching: value.dispatching, ...timestamps,
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
  }
}

export function parseLearningStatus(value: unknown, organizationId: string): LearningStatus {
  if (!isRecord(value) || value.organizationId !== organizationId || typeof value.enabled !== 'boolean'
    || typeof value.stopped !== 'boolean' || !isRecord(value.pipelines)) {
    throw new Error('Main returned invalid learning ownership or status. Refresh before retrying.')
  }
  return {
    organizationId, enabled: value.enabled, stopped: value.stopped,
    pipelines: {
      reflector: parsePipeline(value.pipelines.reflector),
      encapsulator: parsePipeline(value.pipelines.encapsulator),
      soulReflector: parsePipeline(value.pipelines.soulReflector),
    },
  }
}

export function learningPipelineState(status: LearningStatus, pipeline: LearningPipelineStatus): string {
  if (pipeline.dispatching) return status.enabled && !status.stopped ? 'Checking' : 'Stopping check'
  if (status.stopped) return 'Stopped'
  if (!status.enabled) return 'Paused'
  if (pipeline.lastError) return pipeline.pending ? 'Retry pending' : 'Last check failed'
  return pipeline.pending ? 'Waiting for next check' : 'Waiting for activity'
}

export async function fetchLearningStatus(base: string, organizationId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<LearningStatus> {
  return parseLearningStatus(await organizationJson(base, '/api/learning', { signal }, request), organizationId)
}
