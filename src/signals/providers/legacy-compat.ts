import { existsSync } from 'node:fs'
import { projectStoragePath } from '../../utils/data-paths.ts'

/** Compatibility only: never rename/delete an existing Project's provider state. */
export function providerStatePath(project: string): string {
  const current = projectStoragePath(project, '.signals', 'providers-v2.json')
  const legacy = projectStoragePath(project, '.events', 'providers-v1.json')
  if (existsSync(current) && existsSync(legacy)) throw new Error('Both signal and legacy provider states exist; reconcile explicitly before starting')
  return existsSync(legacy) ? legacy : current
}

/** Old authored code remains immutable. Translate its wire result, not its source. */
export function collectionInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!('events' in record)) return value
  if ('signals' in record) throw new Error('Ambiguous collection: both signals and legacy events')
  const { events, ...rest } = record
  return { ...rest, signals: events }
}

/** Read old manifests at the boundary, preserving code/checkpoints/demand identity. */
export function definitionInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const { eventSchema, ...rest } = record
  if ('eventSchema' in record && 'signalSchema' in record) throw new Error('Ambiguous provider schema')
  return { ...rest, ...('eventSchema' in record ? { signalSchema: eventSchema } : {}),
    ...('examples' in record && Array.isArray(record.examples) ? { examples: record.examples.map(example => {
      if (!example || typeof example !== 'object' || !('event' in example)) return example
      if ('signal' in example) throw new Error('Ambiguous provider example')
      const { event, ...fields } = example
      return { ...fields, signal: event }
    }) } : {}) }
}

export function stateInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const state = value as Record<string, unknown>
  if (state.format !== 1) return value
  return { ...state, format: 2,
    definitions: Array.isArray(state.definitions) ? state.definitions.map(definitionInput) : state.definitions,
    jobs: Array.isArray(state.jobs) ? state.jobs.map(job => {
      if (!job || typeof job !== 'object' || !('event' in job)) return job
      if ('signal' in job) throw new Error('Ambiguous pending provider job')
      const { event, ...fields } = job
      return { ...fields, signal: event }
    }) : state.jobs }
}

/** Legacy processors receive their old argument; current processors use only signal. */
export function processorInput(signal: unknown): { signal: unknown; event: unknown } {
  return { signal, event: signal }
}

/** Historical tool calls can still resolve, but are never advertised in discovery. */
export const legacySignalToolName = (name: string): string => name === 'event_provider' ? 'signal_provider' : name

/** Keep broker mutation-receipt revision identity for immutable old custom code. */
export function legacyDefinitionWire(definition: import('./contracts.ts').ProviderDefinition): unknown {
  const { signalSchema, examples, ...fields } = definition
  return { ...fields, eventSchema: signalSchema, examples: examples.map(({ signal, ...example }) => ({ ...example, event: signal })) }
}
