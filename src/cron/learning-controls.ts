import type { Config } from '../config/schema.ts'

type Learning = Config['learning'] & { enabled?: boolean }
const jobs = {
  'learning:reflector': ['reflector', 'reflectIntervalMs'],
  'learning:encapsulator': ['encapsulator', 'encapsulateIntervalMs'],
  'learning:soul-reflector': ['soulReflector', 'soulIntervalMs'],
} as const
function keys(id: string) {
  if (!Object.hasOwn(jobs, id)) throw new Error('Unknown learning automation')
  return jobs[id as keyof typeof jobs]
}
export function learningInterval(config: Learning, id: string): number {
  return config[keys(id)[1]]
}
export function updateLearningInterval(config: Learning, id: string, intervalMs: number): Learning {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 35791 * 60_000 || intervalMs % 60_000 !== 0) {
    throw new Error('Learning intervals must be whole minutes from 1 to 35791.')
  }
  return { ...config, [keys(id)[1]]: intervalMs }
}
export function updateLearningEnabled(config: Learning, id: string, enabled: boolean): Learning {
  const pipeline = keys(id)[0]
  // Convert the legacy global pause only on an explicit enable. Preserve the
  // effective disabled intention for every other pipeline, including defaults.
  const normalize = enabled && config.enabled === false
  return { ...config, ...(normalize ? { enabled: true } : {}), pipelines: {
    ...config.pipelines,
    ...(normalize ? { reflector: false, encapsulator: false, soulReflector: false } : {}),
    [pipeline]: enabled,
  } }
}
