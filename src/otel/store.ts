import { DatabaseSync as Database } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { transaction } from '../utils/sqlite.ts'

// ─── SQLite Storage ──────────────────────────────────────────────────────────

/**
 * SQLite-backed storage for OTLP spans, logs and metrics received via HTTP.
 */
export class OtelStore {
  private db: Database
  private insertSpan: ReturnType<Database['prepare']>
  private insertLog: ReturnType<Database['prepare']>
  private insertMetric: ReturnType<Database['prepare']>

  constructor(dbPath: string) {
    const dir = dirname(dbPath)
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.initSchema()

    this.insertSpan = this.db.prepare(`
      INSERT INTO otel_spans (
        trace_id, span_id, parent_span_id, name, kind,
        start_time, end_time, status_code, status_message,
        attributes, events, resource, scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.insertLog = this.db.prepare(`
      INSERT INTO otel_logs (
        time, observed_time, severity, severity_text, body,
        attributes, trace_id, span_id, resource, scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.insertMetric = this.db.prepare(`
      INSERT INTO otel_metrics (
        time, name, description, unit, type, data,
        attributes, resource, scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS otel_spans (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id    TEXT NOT NULL,
        span_id     TEXT NOT NULL,
        parent_span_id TEXT,
        name        TEXT NOT NULL,
        kind        INTEGER,
        start_time  INTEGER NOT NULL,
        end_time    INTEGER,
        status_code INTEGER,
        status_message TEXT,
        attributes  TEXT,
        events      TEXT,
        resource    TEXT,
        scope       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spans_trace  ON otel_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_spans_start  ON otel_spans(start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_spans_name   ON otel_spans(name);

      CREATE TABLE IF NOT EXISTS otel_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        time          INTEGER NOT NULL,
        observed_time INTEGER,
        severity      INTEGER,
        severity_text TEXT,
        body          TEXT,
        attributes    TEXT,
        trace_id      TEXT,
        span_id       TEXT,
        resource      TEXT,
        scope         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_time     ON otel_logs(time DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_severity ON otel_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_logs_trace    ON otel_logs(trace_id);

      CREATE TABLE IF NOT EXISTS otel_metrics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        time        INTEGER NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        unit        TEXT,
        type        TEXT,
        data        TEXT,
        attributes  TEXT,
        resource    TEXT,
        scope       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_time ON otel_metrics(time DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON otel_metrics(name);
    `)
  }

  // ── Ingest ──────────────────────────────────────────────────────────────

  ingestTraces(body: OtlpTraceExport): number {
    let count = 0
    transaction(this.db, () => {
      for (const rs of body.resourceSpans ?? []) {
        const resource = rs.resource ? JSON.stringify(rs.resource) : null
        for (const ss of rs.scopeSpans ?? []) {
          const scope = ss.scope ? JSON.stringify(ss.scope) : null
          for (const span of ss.spans ?? []) {
            this.insertSpan.run(
              span.traceId ?? '',
              span.spanId ?? '',
              span.parentSpanId ?? null,
              span.name ?? '',
              span.kind ?? 0,
              nanoToMs(span.startTimeUnixNano),
              nanoToMs(span.endTimeUnixNano),
              span.status?.code ?? 0,
              span.status?.message ?? null,
              span.attributes ? JSON.stringify(span.attributes) : null,
              span.events ? JSON.stringify(span.events) : null,
              resource,
              scope,
            )
            count++
          }
        }
      }
    })
    return count
  }

  ingestLogs(body: OtlpLogExport): number {
    let count = 0
    transaction(this.db, () => {
      for (const rl of body.resourceLogs ?? []) {
        const resource = rl.resource ? JSON.stringify(rl.resource) : null
        for (const sl of rl.scopeLogs ?? []) {
          const scope = sl.scope ? JSON.stringify(sl.scope) : null
          for (const log of sl.logRecords ?? []) {
            this.insertLog.run(
              nanoToMs(log.timeUnixNano),
              nanoToMs(log.observedTimeUnixNano),
              log.severityNumber ?? 0,
              log.severityText ?? null,
              log.body ? JSON.stringify(log.body) : null,
              log.attributes ? JSON.stringify(log.attributes) : null,
              log.traceId ?? null,
              log.spanId ?? null,
              resource,
              scope,
            )
            count++
          }
        }
      }
    })
    return count
  }

  ingestMetrics(body: OtlpMetricExport): number {
    let count = 0
    transaction(this.db, () => {
      for (const rm of body.resourceMetrics ?? []) {
        const resource = rm.resource ? JSON.stringify(rm.resource) : null
        for (const sm of rm.scopeMetrics ?? []) {
          const scope = sm.scope ? JSON.stringify(sm.scope) : null
          for (const metric of sm.metrics ?? []) {
            const { type, dataPoints } = extractMetricData(metric)
            for (const dp of dataPoints) {
              this.insertMetric.run(
                nanoToMs(dp.timeUnixNano),
                metric.name ?? '',
                metric.description ?? null,
                metric.unit ?? null,
                type,
                JSON.stringify(dp),
                dp.attributes ? JSON.stringify(dp.attributes) : null,
                resource,
                scope,
              )
              count++
            }
          }
        }
      }
    })
    return count
  }

  // ── Query ───────────────────────────────────────────────────────────────

  querySpans(
    opts: QueryOpts & { traceId?: string; name?: string } = {},
  ): unknown[] {
    const { where, params } = buildWhere([
      opts.afterId !== undefined ? { sql: 'id > ?', val: opts.afterId } : null,
      opts.beforeId !== undefined
        ? { sql: 'id < ?', val: opts.beforeId }
        : null,
      opts.traceId !== undefined
        ? { sql: 'trace_id = ?', val: opts.traceId }
        : null,
      opts.name !== undefined ? { sql: 'name = ?', val: opts.name } : null,
    ])
    const order = opts.ascending ? 'ASC' : 'DESC'
    const limit = opts.limit ?? 100
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM otel_spans ${where} ORDER BY id ${order} LIMIT ?`,
    ).all(...params)
  }

  queryLogs(
    opts: QueryOpts & { traceId?: string; minSeverity?: number } = {},
  ): unknown[] {
    const { where, params } = buildWhere([
      opts.afterId !== undefined ? { sql: 'id > ?', val: opts.afterId } : null,
      opts.beforeId !== undefined
        ? { sql: 'id < ?', val: opts.beforeId }
        : null,
      opts.traceId !== undefined
        ? { sql: 'trace_id = ?', val: opts.traceId }
        : null,
      opts.minSeverity !== undefined
        ? { sql: 'severity >= ?', val: opts.minSeverity }
        : null,
    ])
    const order = opts.ascending ? 'ASC' : 'DESC'
    const limit = opts.limit ?? 100
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM otel_logs ${where} ORDER BY id ${order} LIMIT ?`,
    ).all(...params)
  }

  queryMetrics(opts: QueryOpts & { name?: string } = {}): unknown[] {
    const { where, params } = buildWhere([
      opts.afterId !== undefined ? { sql: 'id > ?', val: opts.afterId } : null,
      opts.beforeId !== undefined
        ? { sql: 'id < ?', val: opts.beforeId }
        : null,
      opts.name !== undefined ? { sql: 'name = ?', val: opts.name } : null,
    ])
    const order = opts.ascending ? 'ASC' : 'DESC'
    const limit = opts.limit ?? 100
    params.push(limit)
    return this.db.prepare(
      `SELECT * FROM otel_metrics ${where} ORDER BY id ${order} LIMIT ?`,
    ).all(...params)
  }

  countSpans(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM otel_spans').get() as {
      cnt: number
    }).cnt
  }
  countLogs(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM otel_logs').get() as {
      cnt: number
    }).cnt
  }
  countMetrics(): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM otel_metrics')
      .get() as { cnt: number }).cnt
  }

  getLatestSpanId(): number {
    return (this.db.prepare('SELECT MAX(id) as v FROM otel_spans').get() as {
      v: number | null
    }).v ?? 0
  }
  getLatestLogId(): number {
    return (this.db.prepare('SELECT MAX(id) as v FROM otel_logs').get() as {
      v: number | null
    }).v ?? 0
  }

  close(): void {
    this.db.close()
  }
}

// ─── OTLP Types (JSON encoding) ─────────────────────────────────────────────

export interface OtlpTraceExport {
  resourceSpans?: {
    resource?: Record<string, unknown>
    scopeSpans?: {
      scope?: Record<string, unknown>
      spans?: {
        traceId?: string
        spanId?: string
        parentSpanId?: string
        name?: string
        kind?: number
        startTimeUnixNano?: string | number
        endTimeUnixNano?: string | number
        status?: { code?: number; message?: string }
        attributes?: unknown[]
        events?: unknown[]
      }[]
    }[]
  }[]
}

export interface OtlpLogExport {
  resourceLogs?: {
    resource?: Record<string, unknown>
    scopeSpans?: never
    scopeLogs?: {
      scope?: Record<string, unknown>
      logRecords?: {
        timeUnixNano?: string | number
        observedTimeUnixNano?: string | number
        severityNumber?: number
        severityText?: string
        body?: unknown
        attributes?: unknown[]
        traceId?: string
        spanId?: string
      }[]
    }[]
  }[]
}

export interface OtlpMetricExport {
  resourceMetrics?: {
    resource?: Record<string, unknown>
    scopeMetrics?: {
      scope?: Record<string, unknown>
      metrics?: OtlpMetric[]
    }[]
  }[]
}

interface OtlpMetric {
  name?: string
  description?: string
  unit?: string
  gauge?: { dataPoints?: DataPoint[] }
  sum?: {
    dataPoints?: DataPoint[]
    isMonotonic?: boolean
    aggregationTemporality?: number
  }
  histogram?: { dataPoints?: DataPoint[] }
  summary?: { dataPoints?: DataPoint[] }
}

// deno-lint-ignore no-explicit-any
type DataPoint = Record<string, any>

export interface QueryOpts {
  afterId?: number
  beforeId?: number
  limit?: number
  ascending?: boolean
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function nanoToMs(v?: string | number): number {
  if (v === undefined || v === null) return Date.now()
  const n = typeof v === 'string' ? BigInt(v) : BigInt(v)
  return Number(n / 1_000_000n)
}

function buildWhere(
  conditions: (null | { sql: string; val: number | string })[],
): { where: string; params: (number | string)[] } {
  const parts: string[] = []
  const params: (number | string)[] = []
  for (const c of conditions) {
    if (c) {
      parts.push(c.sql)
      params.push(c.val)
    }
  }
  return {
    where: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  }
}

function extractMetricData(
  m: OtlpMetric,
): { type: string; dataPoints: DataPoint[] } {
  if (m.gauge) return { type: 'gauge', dataPoints: m.gauge.dataPoints ?? [] }
  if (m.sum) return { type: 'sum', dataPoints: m.sum.dataPoints ?? [] }
  if (m.histogram) {
    return { type: 'histogram', dataPoints: m.histogram.dataPoints ?? [] }
  }
  if (m.summary) {
    return { type: 'summary', dataPoints: m.summary.dataPoints ?? [] }
  }
  return { type: 'unknown', dataPoints: [] }
}
