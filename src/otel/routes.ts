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

function sseStream(store: OtelStore, kind: 'spans' | 'logs'): Response {
  let lastId = kind === 'spans'
    ? store.getLatestSpanId()
    : store.getLatestLogId()
  let closed = false
  const enc = new TextEncoder()

  const stream = new ReadableStream({
    start(c) {
      c.enqueue(
        enc.encode(
          `event: hello\ndata: {"status":"ok","lastId":${lastId}}\n\n`,
        ),
      )
    },
    async pull(c) {
      while (!closed) {
        try {
          const rows = (kind === 'spans'
            ? store.querySpans({ afterId: lastId, limit: 50, ascending: true })
            : store.queryLogs({
              afterId: lastId,
              limit: 50,
              ascending: true,
            })) as { id: number }[]
          for (const row of rows) {
            c.enqueue(
              enc.encode(`event: ${kind === 'spans' ? 'span' : 'log'}\n`),
            )
            c.enqueue(enc.encode(`data: ${JSON.stringify(row)}\n\n`))
            lastId = row.id
          }
        } catch { /* keep alive */ }
        await new Promise((r) => setTimeout(r, 1000))
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/**
 * Gateway plugin that exposes OTLP/HTTP ingest, query, and SSE streams.
 *
 *   POST /v1/traces  /v1/logs  /v1/metrics      — OTLP/HTTP JSON ingest
 *   GET  /v1/query/{spans,logs,metrics,stats}   — paged queries
 *   GET  /v1/stream/{spans,logs}                — SSE tail
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

    // ── SSE streams ────────────────────────────────────────────────────
    app.get('/v1/stream/spans', () => sseStream(store, 'spans'))
    app.get('/v1/stream/logs', () => sseStream(store, 'logs'))
  }
}
