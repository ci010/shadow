export interface UsageMetrics {
 providerCalls: number
 knownUsageCalls: number
 unknownUsageCalls: number
 inputTokens: number | null
 outputTokens: number | null
 totalTokens: number | null
 toolCalls: number
 scanLimitReached?: boolean
 trackedSessions: number
 untrackedSessions: number
}
export interface SessionProfile {
 sessionId: string
 scope: 'own_and_descendants'
 asOf: string
 rolling24h: { own: UsageMetrics; inclusive: UsageMetrics }
 total: { own: UsageMetrics; inclusive: UsageMetrics }
 limitations: string[]
}
