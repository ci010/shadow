import type { Hono } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import type {
  OtelStore,
  OtlpLogExport,
  OtlpMetricExport,
  OtlpTraceExport,
} from './store.ts'

function intParam(
  c: { req: { query: (k: string) => string | undefined } },
  name: string,
): number | undefined {
  const v = c.req.query(name)
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

/**
 * Gateway plugin that exposes OTLP/HTTP ingest and queries.
 *
 *   POST /v1/traces  /v1/logs  /v1/metrics      — OTLP/HTTP JSON ingest
 *   GET  /v1/query/{spans,session-spans,logs,metrics,stats} — paged queries
 * Realtime tails use project topics on /api/live.
 */
export function otelPlugin(store: OtelStore): GatewayPlugin {
  return (app: Hono) => {
    // ── Ingest ─────────────────────────────────────────────────────────
    app.post('/v1/traces', async (c) => {
      try {
        const body = (await c.req.json()) as OtlpTraceExport
        const count = store.ingestTraces(body)
        return c.json({ partialSuccess: { rejectedSpans: 0 }, accepted: count })
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : String(err),
        }, 400)
      }
    })

    app.post('/v1/logs', async (c) => {
      try {
        const body = (await c.req.json()) as OtlpLogExport
        const count = store.ingestLogs(body)
        return c.json({
          partialSuccess: { rejectedLogRecords: 0 },
          accepted: count,
        })
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : String(err),
        }, 400)
      }
    })

    app.post('/v1/metrics', async (c) => {
      try {
        const body = (await c.req.json()) as OtlpMetricExport
        const count = store.ingestMetrics(body)
        return c.json({
          partialSuccess: { rejectedDataPoints: 0 },
          accepted: count,
        })
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : String(err),
        }, 400)
      }
    })

    // ── Query ──────────────────────────────────────────────────────────
    app.get('/v1/query/session-spans', (c) => {
      const values = c.req.queries()
      for (const key of ['sessionId', 'physicalSessionId', 'beforeId', 'limit']) {
        if ((values[key]?.length ?? 0) > 1) {
          return c.json({ error: `${key} must be specified once` }, 400)
        }
      }
      const sessionId = c.req.query('sessionId')
      const physicalSessionId = c.req.query('physicalSessionId')
      if (sessionId === undefined || !sessionId.trim()) {
        return c.json({ error: 'sessionId must be nonempty' }, 400)
      }
      if (physicalSessionId !== undefined && !physicalSessionId.trim()) {
        return c.json({ error: 'physicalSessionId must be nonempty when supplied' }, 400)
      }
      const before = c.req.query('beforeId')
      const size = c.req.query('limit')
      if (before !== undefined &&
        (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before)))) {
        return c.json({ error: 'beforeId must be a positive safe integer' }, 400)
      }
      if (size !== undefined &&
        (!/^[1-9]\d*$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > 500)) {
        return c.json({ error: 'limit must be an integer between 1 and 500' }, 400)
      }
      try {
        return c.json(store.querySessionSpans({
          sessionId, physicalSessionId,
          beforeId: before === undefined ? undefined : Number(before),
          limit: size === undefined ? 200 : Number(size),
        }))
      } catch (error) {
        console.error('[otel] Failed to query session spans:', error)
        return c.json({ error: 'Failed to query session spans' }, 500)
      }
    })

    app.get('/v1/query/spans', (c) => {
      const ascending = c.req.query('ascending') === 'true'
      const limit = Math.min(intParam(c, 'limit') ?? 100, 1000)
      const afterId = intParam(c, 'afterId')
      const beforeId = intParam(c, 'beforeId')
      const traceId = c.req.query('traceId') ?? undefined
      const name = c.req.query('name') ?? undefined
      return c.json({
        total: store.countSpans(),
        entries: store.querySpans({
          afterId,
          beforeId,
          limit,
          ascending,
          traceId,
          name,
        }),
      })
    })

    app.get('/v1/query/logs', (c) => {
      const ascending = c.req.query('ascending') === 'true'
      const limit = Math.min(intParam(c, 'limit') ?? 100, 1000)
      const afterId = intParam(c, 'afterId')
      const beforeId = intParam(c, 'beforeId')
      const traceId = c.req.query('traceId') ?? undefined
      const minSeverity = intParam(c, 'minSeverity')
      return c.json({
        total: store.countLogs(),
        entries: store.queryLogs({
          afterId,
          beforeId,
          limit,
          ascending,
          traceId,
          minSeverity,
        }),
      })
    })

    app.get('/v1/query/metrics', (c) => {
      const ascending = c.req.query('ascending') === 'true'
      const limit = Math.min(intParam(c, 'limit') ?? 100, 1000)
      const afterId = intParam(c, 'afterId')
      const beforeId = intParam(c, 'beforeId')
      const name = c.req.query('name') ?? undefined
      return c.json({
        total: store.countMetrics(),
        entries: store.queryMetrics({
          afterId,
          beforeId,
          limit,
          ascending,
          name,
        }),
      })
    })

    app.get('/v1/query/stats', (c) =>
      c.json({
        spans: store.countSpans(),
        logs: store.countLogs(),
        metrics: store.countMetrics(),
      }))

    for (const kind of ['spans', 'logs']) {
      app.get(`/v1/stream/${kind}`, (c) => c.json({
        error: 'stream_retired', message: `Subscribe to ${kind} topics through /api/live.`,
      }, 410))
    }
  }
}
