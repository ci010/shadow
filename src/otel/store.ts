import { DatabaseSync as Database, type SQLOutputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { transaction } from '../utils/sqlite.ts'
import type { SessionTraceResponse, SessionTraceSpan } from './session-trace.ts'

const EXECUTION_SPAN_NAMES_SQL =
  "'session.processMessage', 'agent.loop', 'agent.chat', 'agent.tool'"

// ─── SQLite Storage ──────────────────────────────────────────────────────────

/**
 * SQLite-backed storage for OTLP spans, logs and metrics received via HTTP.
 */
export class OtelStore {
  private db: Database
  private insertSpan: ReturnType<Database['prepare']>
  private insertLog: ReturnType<Database['prepare']>
  private insertMetric: ReturnType<Database['prepare']>
  private insertSessionSpan: ReturnType<Database['prepare']>
  private liveSpans = new Map<string, () => OtlpSpan>()

  constructor(dbPath: string) {
    const dir = dirname(dbPath)
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.initSchema()
    this.initSessionTraceIndex()
    this.insertSessionSpan = this.db.prepare(`
      INSERT OR IGNORE INTO otel_session_span_index (
        trace_id, span_id, row_id, parent_span_id, session_id,
        physical_session_id, has_start_time, name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

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

  private initSessionTraceIndex(): void {
    if (this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'otel_session_span_index'",
    ).get()) {
      const columns = this.db.prepare('PRAGMA table_info(otel_session_span_index)').all()
      if (!columns.some((column) => column.name === 'name')) {
        transaction(this.db, () => {
          this.db.exec(`
            ALTER TABLE otel_session_span_index ADD COLUMN name TEXT NOT NULL DEFAULT '';
            UPDATE otel_session_span_index SET name = COALESCE(
              (SELECT name FROM otel_spans WHERE id = row_id), ''
            );
            CREATE INDEX idx_session_spans_execution_owner
              ON otel_session_span_index(session_id, name, physical_session_id);
          `)
        })
      }
      return
    }

    // Backfill once, atomically and in bounded batches. Global OTLP rows stay
    // unchanged; the first exported row owns each stable span identity.
    transaction(this.db, () => {
      this.db.exec(`
        CREATE TABLE otel_session_span_index (
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          row_id INTEGER NOT NULL UNIQUE,
          parent_span_id TEXT,
          session_id TEXT,
          physical_session_id TEXT,
          has_start_time INTEGER NOT NULL,
          name TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id)
        );
        CREATE INDEX idx_session_spans_execution_owner
          ON otel_session_span_index(session_id, name, physical_session_id);
        CREATE INDEX idx_session_spans_parent
          ON otel_session_span_index(trace_id, parent_span_id);
      `)
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO otel_session_span_index
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const batch = this.db.prepare(
        'SELECT * FROM otel_spans WHERE id > ? ORDER BY id LIMIT 500',
      )
      let afterId = 0
      for (;;) {
        const rows = batch.all(afterId) as StoredSpan[]
        if (rows.length === 0) break
        for (const row of rows) {
          const owner = spanOwnership(parseStoredJson(row.attributes))
          insert.run(
            row.trace_id, row.span_id, row.id, row.parent_span_id,
            owner.sessionId, owner.physicalSessionId,
            Number(Number.isFinite(row.start_time)),
            row.name,
          )
          afterId = row.id
        }
      }
    })
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
            const startTime = traceNanoToMs(span.startTimeUnixNano)
            const inserted = this.insertSpan.run(
              span.traceId ?? '',
              span.spanId ?? '',
              span.parentSpanId ?? null,
              span.name ?? '',
              span.kind ?? 0,
              startTime ?? 0,
              traceNanoToMs(span.endTimeUnixNano) ?? null,
              span.status?.code ?? 0,
              span.status?.message ?? null,
              span.attributes ? JSON.stringify(span.attributes) : null,
              span.events ? JSON.stringify(span.events) : null,
              resource,
              scope,
            )
            const owner = spanOwnership(span.attributes)
            this.insertSessionSpan.run(
              span.traceId ?? '', span.spanId ?? '', Number(inserted.lastInsertRowid),
              span.parentSpanId ?? null, owner.sessionId,
              owner.physicalSessionId, Number(startTime !== undefined),
              span.name ?? '',
            )
            count++
          }
        }
      }
    })
    for (const rs of body.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          this.endLiveSpan(span.traceId ?? '', span.spanId ?? '')
        }
      }
    }
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

  registerLiveSpan(traceId: string, spanId: string, snapshot: () => OtlpSpan): void {
    this.liveSpans.set(spanKey(traceId, spanId), snapshot)
  }

  endLiveSpan(traceId: string, spanId: string): void {
    this.liveSpans.delete(spanKey(traceId, spanId))
  }

  clearLiveSpans(): void {
    this.liveSpans.clear()
  }

  /**
   * `limit` bounds completed history; live snapshots are an additive latest-page
   * overlay and never consume or advance its cursor. Descendants inherit only
   * through known parent links, not merely a shared trace ID. Only execution
   * spans seed ancestry; standalone history reads must not trace their own UI.
   */
  querySessionSpans(opts: {
    sessionId: string
    physicalSessionId?: string
    beforeId?: number
    limit?: number
  }): SessionTraceResponse {
    const limit = opts.limit ?? 200
    if (!opts.sessionId.trim() ||
      (opts.physicalSessionId !== undefined && !opts.physicalSessionId.trim()) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
      (opts.beforeId !== undefined &&
        (!Number.isSafeInteger(opts.beforeId) || opts.beforeId < 1))) {
      throw new Error('Invalid session trace query')
    }

    const live = new Map<string, SessionTraceSpan>()
    const nodes: Array<{
      trace_id: string
      span_id: string
      parent_span_id: string | null
      session_id: string | null
      physical_session_id: string | null
      name: string
    }> = []
    const persisted = this.db.prepare(
      'SELECT 1 FROM otel_session_span_index WHERE trace_id = ? AND span_id = ?',
    )
    for (const snapshot of this.liveSpans.values()) {
      const span = snapshot()
      const traceId = span.traceId ?? ''
      const spanId = span.spanId ?? ''
      if (!traceId || !spanId || persisted.get(traceId, spanId)) continue
      const attrs = normalizeAttributes(span.attributes)
      const owner = spanOwnership(span.attributes)
      nodes.push({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: span.parentSpanId ?? null,
        session_id: owner.sessionId,
        physical_session_id: owner.physicalSessionId,
        name: span.name ?? '',
      })
      const startTime = traceNanoToMs(span.startTimeUnixNano)
      if (startTime !== undefined) {
        live.set(spanKey(traceId, spanId), {
          id: null, traceId, spanId, name: span.name ?? '', startTime, live: true,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          ...(span.status?.code !== undefined ? { statusCode: span.status.code } : {}),
          ...(span.status?.message !== undefined ? { statusMessage: span.status.message } : {}),
          attributes: attrs,
          events: normalizeEvents(span.events),
        })
      }
    }

    // UNION (not UNION ALL) makes malformed cycles finite. Same-session
    // annotations can refine a segment, but foreign session boundaries stop
    // traversal. The seed name index excludes independent administrative reads.
    const ancestry = `
      WITH RECURSIVE
      live AS (
        SELECT
          json_extract(value, '$.trace_id') AS trace_id,
          json_extract(value, '$.span_id') AS span_id,
          json_extract(value, '$.parent_span_id') AS parent_span_id,
          json_extract(value, '$.session_id') AS session_id,
          json_extract(value, '$.physical_session_id') AS physical_session_id,
          json_extract(value, '$.name') AS name
        FROM json_each(?)
      ),
      owned(trace_id, span_id, physical_session_id) AS (
        SELECT trace_id, span_id, physical_session_id
        FROM otel_session_span_index
        WHERE session_id = ? AND trace_id != '' AND span_id != ''
          AND name IN (${EXECUTION_SPAN_NAMES_SQL})
        UNION
        SELECT trace_id, span_id, physical_session_id
        FROM live WHERE session_id = ? AND trace_id != '' AND span_id != ''
          AND name IN (${EXECUTION_SPAN_NAMES_SQL})
        UNION
        SELECT child.trace_id, child.span_id,
          COALESCE(child.physical_session_id, parent.physical_session_id)
        FROM owned parent JOIN otel_session_span_index child
          ON child.trace_id = parent.trace_id AND child.parent_span_id = parent.span_id
        WHERE child.span_id != '' AND (
          child.session_id = ? OR (child.session_id IS NULL AND (
            child.physical_session_id IS NULL OR parent.physical_session_id IS NULL
            OR child.physical_session_id = parent.physical_session_id
          ))
        )
        UNION
        SELECT child.trace_id, child.span_id,
          COALESCE(child.physical_session_id, parent.physical_session_id)
        FROM owned parent JOIN live child
          ON child.trace_id = parent.trace_id AND child.parent_span_id = parent.span_id
        WHERE child.span_id != '' AND (
          child.session_id = ? OR (child.session_id IS NULL AND (
            child.physical_session_id IS NULL OR parent.physical_session_id IS NULL
            OR child.physical_session_id = parent.physical_session_id
          ))
        )
      ),
      scoped AS (
        SELECT DISTINCT trace_id, span_id FROM owned
        WHERE (? IS NULL OR physical_session_id = ?)
          AND trace_id != '' AND span_id != ''
      )
    `
    const params = [
      JSON.stringify(nodes), opts.sessionId, opts.sessionId,
      opts.sessionId, opts.sessionId,
      opts.physicalSessionId ?? null, opts.physicalSessionId ?? null,
    ]
    const rows = this.db.prepare(`${ancestry}
      SELECT spans.* FROM scoped
      JOIN otel_session_span_index node
        ON node.trace_id = scoped.trace_id AND node.span_id = scoped.span_id
      JOIN otel_spans spans ON spans.id = node.row_id
      WHERE node.has_start_time = 1 ${opts.beforeId === undefined ? '' : 'AND spans.id < ?'}
      ORDER BY spans.id DESC LIMIT ?
    `).all(
      ...params, ...(opts.beforeId === undefined ? [] : [opts.beforeId]), limit + 1,
    ) as StoredSpan[]
    const hasMore = rows.length > limit
    const entries = rows.slice(0, limit).map(normalizeStoredSpan)
    const nextBeforeId = entries.at(-1)?.id ?? undefined
    if (opts.beforeId === undefined && live.size > 0) {
      const ownedLive = this.db.prepare(`${ancestry}
        SELECT live.trace_id, live.span_id FROM scoped JOIN live
          ON live.trace_id = scoped.trace_id AND live.span_id = scoped.span_id
      `).all(...params)
      const active: SessionTraceSpan[] = []
      for (const row of ownedLive) {
        const span = live.get(spanKey(String(row.trace_id), String(row.span_id)))
        if (span) active.push(span)
      }
      active.sort((a, b) => b.startTime - a.startTime ||
        a.traceId.localeCompare(b.traceId) || a.spanId.localeCompare(b.spanId))
      entries.push(...active)
    }
    return {
      sessionId: opts.sessionId,
      ...(opts.physicalSessionId !== undefined ? { physicalSessionId: opts.physicalSessionId } : {}),
      entries,
      hasMore,
      ...(nextBeforeId !== undefined ? { nextBeforeId } : {}),
    }
  }

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
    this.clearLiveSpans()
    this.db.close()
  }
}

// ─── OTLP Types (JSON encoding) ─────────────────────────────────────────────

export interface OtlpTraceExport {
  resourceSpans?: {
    resource?: Record<string, unknown>
    scopeSpans?: {
      scope?: Record<string, unknown>
      spans?: OtlpSpan[]
    }[]
  }[]
}

export interface OtlpSpan {
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

interface StoredSpan extends Record<string, SQLOutputValue> {
  id: number
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  start_time: number
  end_time: number | null
  status_code: number | null
  status_message: string | null
  attributes: string | null
  events: string | null
}

function spanKey(traceId: string, spanId: string): string {
  return JSON.stringify([traceId, spanId])
}

function traceNanoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (!/^\d+$/.test(String(value))) return undefined
  const nanos = BigInt(value)
  const ms = Number(nanos / 1_000_000n) + Number(nanos % 1_000_000n) / 1_000_000
  return Number.isFinite(ms) ? ms : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStoredJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // Old malformed optional OTLP fields cannot establish ownership.
    return { malformed: true }
  }
}

function spanOwnership(value: unknown): {
  sessionId: string | null
  physicalSessionId: string | null
} {
  const owner: {
    sessionId: string | null
    physicalSessionId: string | null
  } = { sessionId: null, physicalSessionId: null }
  if (value === undefined || value === null) return owner
  // An unreadable annotation must block inheritance, not silently turn into
  // an unannotated child of another session.
  if (!Array.isArray(value)) return { sessionId: '', physicalSessionId: '' }
  for (const key of ['sessionId', 'physicalSessionId'] as const) {
    const annotations = value.filter((entry) => isRecord(entry) && entry.key === key)
    if (annotations.length === 0) continue
    const entry = annotations[0]
    owner[key] = annotations.length === 1 && isRecord(entry) &&
        isRecord(entry.value) && typeof entry.value.stringValue === 'string' &&
        entry.value.stringValue.trim()
      ? entry.value.stringValue : ''
  }
  return owner
}

function otlpValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) {
    const scalar = value[key]
    if (typeof scalar === 'string' || typeof scalar === 'boolean' ||
      (typeof scalar === 'number' && Number.isFinite(scalar))) return scalar
  }
  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(otlpValue)
  }
  if (isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
    return normalizeAttributes(value.kvlistValue.values)
  }
  return undefined
}

function normalizeAttributes(value: unknown): Record<string, string> {
  const entries: Array<[string, string]> = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue
      const decoded = otlpValue(entry.value)
      if (decoded === undefined) continue
      entries.push([entry.key, typeof decoded === 'object'
        ? JSON.stringify(decoded) : String(decoded)])
    }
  }
  return Object.fromEntries(entries)
}

function normalizeEvents(value: unknown): SessionTraceSpan['events'] {
  if (!Array.isArray(value)) return []
  const events: SessionTraceSpan['events'] = []
  for (const event of value) {
    if (!isRecord(event) || typeof event.name !== 'string') continue
    const time = traceNanoToMs(event.timeUnixNano)
    if (time === undefined) continue
    events.push({ name: event.name, time, attributes: normalizeAttributes(event.attributes) })
  }
  return events
}

function normalizeStoredSpan(row: StoredSpan): SessionTraceSpan {
  return {
    id: row.id, traceId: row.trace_id, spanId: row.span_id,
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    name: row.name, startTime: row.start_time, live: false,
    ...(row.end_time !== null ? { endTime: row.end_time } : {}),
    ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
    ...(row.status_message !== null ? { statusMessage: row.status_message } : {}),
    attributes: normalizeAttributes(parseStoredJson(row.attributes)),
    events: normalizeEvents(parseStoredJson(row.events)),
  }
}

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
