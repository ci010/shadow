/** Public, aggregate-only telemetry. No prompts, errors, session IDs or model configuration. */
export interface AutomationFrequency {
  kind: 'event' | 'poll' | 'schedule' | 'unknown'
  description: string
  scope: 'current_runtime' | 'configured_job' | 'historical_unknown'
  intervalMs?: number
  schedule?: string
}
export type { UsageMetrics as AutomationUsageMetrics } from '../sessions/profile-contract.ts'
import type { UsageMetrics as AutomationUsageMetrics } from '../sessions/profile-contract.ts'
export interface AutomationProfile {
  featureId: string
  window: { from: string; asOf: string; timezone: 'UTC'; semantics: 'events_completed_in_window_runs_started_in_window' }
  frequency: AutomationFrequency
  runs: { total: number; completed: number; failed: number; partial: number; cancelled: number; running: number; unknown: number; full: number; delta: number }
  usage: AutomationUsageMetrics
  organizationScopes?: Partial<Record<'full' | 'delta', AutomationUsageMetrics>>
  coverage: 'complete' | 'partial' | 'unknown'
  limitations: string[]
}
export type AutomationProfilePolicy = (featureId: string) => AutomationFrequency | undefined
