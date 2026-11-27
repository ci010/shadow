import { parseModelSpec } from '../providers/aggregated.ts'
import { RecallIndex } from './recall-index.ts'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { physicalSessionId } from './session-identity.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import type { ProjectUsageMetrics, RequestQuality, RequestQualityByPeriod } from '../projects/usage-contract.ts'
import { parseTokenUsage } from './usage.ts'

type QualityScope = { provider: string | null; model?: string | null }
function qualityFilter(asOf: number, from: number, scope?: QualityScope) {
  const args: (number | string | null)[] = [from, asOf]
  let where = 'WHERE at >= ? AND at < ?'
  if (scope) {
    where += ' AND provider IS ?'; args.push(scope.provider)
    if (scope.model !== undefined) { where += ' AND quality_model IS ?'; args.push(scope.model) }
  }
  return { where, args }
}
const MIN_AT = Number.MIN_SAFE_INTEGER

type Row = Record<string, unknown>
const indexes = new WeakMap<SessionStore, StatsIndex>()
export const statsIndex = (store: SessionStore) => indexes.get(store)
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null
const ms = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const text = (v: unknown) => typeof v === 'string' ? v : null
export class StatsIndex {
  readonly db: DatabaseSync
  readonly recall: RecallIndex
  private closed = false
  private stopped = false
  private failed = false
  private removed = new Set<string>()
  private filling?: Promise<void>
  complete = false
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS segment (physical TEXT PRIMARY KEY, session TEXT NOT NULL, checkpoint INTEGER);
      CREATE TABLE IF NOT EXISTS model (session TEXT NOT NULL, physical TEXT NOT NULL, id TEXT NOT NULL, at INTEGER, model TEXT, usage TEXT, duration REAL,
        outcome TEXT, first_text REAL, first_dispatch REAL, queue REAL, attempts TEXT, text_observation TEXT, provider TEXT, quality_model TEXT, PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS model_at ON model(at);
      CREATE INDEX IF NOT EXISTS model_session_at ON model(session,at);
      CREATE INDEX IF NOT EXISTS model_first ON model(first_text) WHERE first_text IS NOT NULL;
      CREATE TABLE IF NOT EXISTS daily_model (physical TEXT NOT NULL, day INTEGER NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL,
        tokens INTEGER NOT NULL, known_tokens INTEGER NOT NULL, duration REAL NOT NULL, known_duration INTEGER NOT NULL,
        unknown_cost INTEGER NOT NULL, usd REAL, cny REAL, credits REAL, PRIMARY KEY(physical, day, model));
      CREATE TRIGGER IF NOT EXISTS model_daily AFTER INSERT ON model WHEN new.at IS NOT NULL BEGIN
        INSERT INTO daily_model VALUES (new.physical, (new.at - ((new.at % 86400000 + 86400000) % 86400000)), coalesce(new.model,''), 1,
          coalesce(json_extract(new.usage,'$.totalTokens'),0), json_extract(new.usage,'$.totalTokens') IS NOT NULL,
          coalesce(new.duration,0), new.duration IS NOT NULL,
          json_extract(new.usage,'$.costs') IS NULL OR coalesce(json_extract(new.usage,'$.costIncomplete'),0),
          (SELECT json_extract(value,'$.amount') FROM json_each(new.usage,'$.costs') WHERE json_extract(value,'$.currency')='USD'),
          (SELECT json_extract(value,'$.amount') FROM json_each(new.usage,'$.costs') WHERE json_extract(value,'$.currency')='CNY'),
          (SELECT json_extract(value,'$.amount') FROM json_each(new.usage,'$.costs') WHERE json_extract(value,'$.currency')='AI_CREDITS'))
        ON CONFLICT(physical,day,model) DO UPDATE SET calls=calls+1, tokens=tokens+excluded.tokens, known_tokens=known_tokens+excluded.known_tokens,
          duration=duration+excluded.duration, known_duration=known_duration+excluded.known_duration, unknown_cost=unknown_cost+excluded.unknown_cost,
          usd=CASE WHEN excluded.usd IS NULL THEN usd ELSE coalesce(usd,0)+excluded.usd END,
          cny=CASE WHEN excluded.cny IS NULL THEN cny ELSE coalesce(cny,0)+excluded.cny END,
          credits=CASE WHEN excluded.credits IS NULL THEN credits ELSE coalesce(credits,0)+excluded.credits END;
      END;
      CREATE TABLE IF NOT EXISTS tool (session TEXT NOT NULL, physical TEXT NOT NULL, id TEXT NOT NULL, at INTEGER, names TEXT, PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS tool_at ON tool(at);
      CREATE INDEX IF NOT EXISTS tool_session_at ON tool(session,at);
      CREATE TABLE IF NOT EXISTS tool_names (session TEXT NOT NULL, physical TEXT NOT NULL, id TEXT NOT NULL, names TEXT NOT NULL, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS daily_tool (physical TEXT NOT NULL, day INTEGER NOT NULL, name TEXT NOT NULL, calls INTEGER NOT NULL,
        PRIMARY KEY(physical,day,name));
      CREATE VIEW IF NOT EXISTS tool_detail AS SELECT t.session,t.id,t.physical,t.at,t.names AS fallback,
        (t.at - ((t.at % 86400000 + 86400000) % 86400000)) AS day, coalesce(n.names,t.names) AS names
        FROM tool t LEFT JOIN tool_names n USING(session,id);
      CREATE TRIGGER IF NOT EXISTS tool_daily AFTER INSERT ON tool WHEN new.at IS NOT NULL BEGIN
        INSERT INTO daily_tool SELECT v.physical,v.day,j.value,count(*) FROM tool_detail v,json_each(v.names) j
          WHERE v.session=new.session AND v.id=new.id GROUP BY j.value
          ON CONFLICT(physical,day,name) DO UPDATE SET calls=calls+excluded.calls;
      END;
      CREATE TRIGGER IF NOT EXISTS tool_late_names AFTER INSERT ON tool_names BEGIN
        INSERT INTO daily_tool SELECT v.physical,v.day,j.value,-count(*) FROM tool_detail v,json_each(v.fallback) j
          WHERE v.session=new.session AND v.id=new.id AND v.at IS NOT NULL GROUP BY j.value
          ON CONFLICT(physical,day,name) DO UPDATE SET calls=calls+excluded.calls;
        INSERT INTO daily_tool SELECT v.physical,v.day,j.value,count(*) FROM tool_detail v,json_each(v.names) j
          WHERE v.session=new.session AND v.id=new.id AND v.at IS NOT NULL GROUP BY j.value
          ON CONFLICT(physical,day,name) DO UPDATE SET calls=calls+excluded.calls;
      END;`)
    // Replay source records once to recover provider identity without reinserting usage or firing daily totals.
    if (!this.db.prepare('PRAGMA table_info(model)').all().some(row => row.name === 'provider')) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`ALTER TABLE model ADD COLUMN provider TEXT;
          ALTER TABLE model ADD COLUMN quality_model TEXT;
          UPDATE model SET quality_model=model;
          UPDATE segment SET checkpoint=NULL;`)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS model_quality_scope ON model(provider,quality_model,at);
      CREATE INDEX IF NOT EXISTS model_quality_provider ON model(provider,at);`)
    this.recall = new RecallIndex(this.db, path === ':memory:' ? undefined : join(dirname(path), 'recall-source.jsonl'))
  }
  async close() {
    if (this.closed) return
    this.stopped = true
    await this.filling?.catch(() => undefined)
    if (!this.closed) { this.closed = true; this.db.close() }
  }
  private remove(column: 'session' | 'physical', value: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['daily_model', 'daily_tool']) this.db.prepare(`DELETE FROM ${table} WHERE physical IN (SELECT physical FROM segment WHERE ${column}=?)`).run(value)
      for (const table of ['model', 'tool', 'tool_names', 'segment']) this.db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(value)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  recallMemory(entry: string, source: 'active' | 'automatic', origin: import('./recall-origin.ts').RecallOrigin = 'unknown') {
    if (this.closed) return
    try {
      this.recall.record(entry, source, origin)
    } catch (error) { console.error('[stats] Memory recall indexing failed', error) }
  }
  private bind(physical: string, session: string) {
    this.db.prepare('INSERT OR IGNORE INTO segment (physical,session) VALUES (?,?)').run(physical, session)
  }
  ingest(physical: string, rows: Row[], owner?: string) {
    rows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    if (this.closed || !rows.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const start = rows.find(row => 'previous_physical_id' in row && typeof row.sessionId === 'string')
      const identity = owner ?? text(start?.sessionId) ?? text(rows.find(row => row.type === 'model_usage')?.sessionId)
      if (identity) this.bind(physical, identity)
      const session = text(this.db.prepare('SELECT session FROM segment WHERE physical=?').get(physical)?.session)
      if (session) for (const row of rows) {
        if (row.sessionId !== undefined && row.sessionId !== session) continue
        if (row.type === 'model_usage' && row.sessionId === session && typeof row.id === 'string') {
          const model = text(row.model)
          const parsed = model ? parseModelSpec(model) : undefined
          const provider = text(row.provider) || parsed?.provider || null
          this.db.prepare(`INSERT INTO model (session,physical,id,at,model,usage,duration,outcome,first_text,first_dispatch,queue,attempts,text_observation,provider,quality_model)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session,id) DO UPDATE SET
            provider=excluded.provider, quality_model=excluded.quality_model WHERE model.physical=excluded.physical AND model.provider IS NULL AND excluded.provider IS NOT NULL`).run(session, physical, row.id, time(row.timestamp), model,
            JSON.stringify(parseTokenUsage(row.usage)), ms(row.durationMs), text(row.outcome), ms(row.firstTextMs), ms(row.firstDispatchMs), ms(row.queueMs),
            Array.isArray(row.attempts) ? JSON.stringify(row.attempts.flatMap(attempt => {
              const durationMs = ms(attempt?.durationMs)
              return durationMs === null || !['success', 'failure', 'cancelled'].includes(attempt?.outcome) ? []
                : [{ outcome: attempt.outcome, durationMs, firstTextMs: ms(attempt.firstTextMs), mode: ['stream', 'nonstream'].includes(attempt.mode) ? attempt.mode : null }]
            })) : null, text(row.textObservation), provider, parsed?.provider && parsed.provider === provider ? parsed.model : model)
        } else if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
          for (const call of row.tool_calls) if (typeof call?.id === 'string') {
            this.db.prepare('INSERT OR IGNORE INTO tool_names VALUES (?,?,?,?)').run(session, physical, call.id,
              JSON.stringify(toolNames(call.function?.name, call.function?.arguments)))
          }
        } else if (row.role === 'tool' && typeof row.tool_call_id === 'string') {
          this.db.prepare('INSERT OR IGNORE INTO tool VALUES (?,?,?,?,?)').run(session, physical, row.tool_call_id, time(row.timestamp), JSON.stringify(toolNames(row.name, undefined)))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  attach(store: SessionStore, aliases: Readonly<Record<string, string>> = {}): SessionStore {
    const index = this
    const proxy = new Proxy(store, { get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'deleteSessionLog' || key === 'deleteState') return async (id: string) => {
        await value.call(target, id)
        try {
          if (index.closed) return
          const canonical = aliases[id] ?? id
          if (!index.complete) index.removed.add(canonical)
          index.remove(key === 'deleteState' ? 'session' : 'physical', canonical)
        }
        catch (error) { index.failed = true; index.complete = false; console.error('[stats] Removal failed', error) }
      }
      if (key !== 'appendMessages' && key !== 'appendRawEvents' && key !== 'createSessionLog') return value.bind(target)
      return async (physical: string, rows: Row[]) => {
        await value.call(target, physical, rows)
        try { index.ingest(aliases[physical] ?? physical, rows) }
        catch (error) { index.failed = true; index.complete = false; console.error('[stats] Incremental indexing failed', error) }
      }
    } })
    indexes.set(proxy, this)
    return proxy
  }
  backfill(store: SessionStore, states: SessionState[], projectId: string) {
    return this.filling ??= this.fill(store, states, projectId)
  }
  private async fill(store: SessionStore, states: SessionState[], projectId: string) {
    if (this.stopped) return
    await this.recall.replay(() => this.stopped)
    if (store.queryConversationArchives && store.readArchivedState) for (let cursor: string | undefined; ; ) {
      if (this.stopped) return
      const page = await store.queryConversationArchives({ projectId, limit: 100, cursor })
      for (const item of page.items) {
        if (this.stopped) return
        const state = await store.readArchivedState(item.sessionId)
        if (state) states.push(state)
      }
      if (!(cursor = page.nextCursor)) break
    }
    this.complete = false
    for (const state of states) {
      if (state.projectId !== projectId) continue
      for (let i = 0; i <= state.segmentIndex; i++) {
        await setImmediate()
        if (this.stopped) return
        const physical = physicalSessionId(state, i)
        const removed = () => this.removed.has(physical) || this.removed.has(state.sessionId)
        if (removed()) continue
        this.bind(physical, state.sessionId)
        const count = await store.countSessionLog(physical)
        if (this.stopped) return
        if (removed()) continue
        if (this.db.prepare('SELECT checkpoint FROM segment WHERE physical=?').get(physical)?.checkpoint === count) continue
        let offset = 0
        let batch: Row[] = []
        for await (const row of store.readSessionLog(physical)) {
          if (this.stopped) return
          if (removed()) break
          if (++offset > count) break
          batch.push(row)
          if (batch.length === 256) { this.ingest(physical, batch, state.sessionId); batch = []; await setImmediate() }
        }
        if (removed()) continue
        this.ingest(physical, batch, state.sessionId)
        if (offset >= count) this.db.prepare('UPDATE segment SET checkpoint=? WHERE physical=?').run(count, physical)
        else this.failed = true
      }
    }
    if (!this.stopped) this.complete = !this.failed
    this.removed.clear()
  }
  *days(before: number): Iterable<{ day: number; model: string; usage: ProjectUsageMetrics }> {
    for (const row of this.db.prepare(`SELECT day,model,sum(calls) AS calls,sum(tokens) AS tokens,sum(known_tokens) AS known_tokens,
      sum(duration) AS duration,sum(known_duration) AS known_duration,sum(unknown_cost) AS unknown_cost,
      sum(usd) AS usd,sum(cny) AS cny,sum(credits) AS credits FROM daily_model WHERE day < ? GROUP BY day,model`).iterate(before)) {
      const calls = Number(row.calls), kt = Number(row.known_tokens), kd = Number(row.known_duration)
      const costs = (['USD', 'CNY', 'AI_CREDITS'] as const).flatMap((currency, i) => {
        const amount = row[(['usd', 'cny', 'credits'] as const)[i]!]
        return typeof amount === 'number' ? [{ currency, amount }] : []
      })
      yield { day: Number(row.day), model: String(row.model), usage: { calls, tokens: kt ? Number(row.tokens) : null,
        durationMs: kd ? Number(row.duration) : null, unknownDurationCalls: calls - kd, unknownTokenCalls: calls - kt,
        unknownCostCalls: Number(row.unknown_cost), costs } }
    }
  }
  *toolsByDay(today: number, asOf: number): Iterable<{ day: number; name: string; calls: number }> {
    const sql = `SELECT day,name,sum(calls) AS calls FROM daily_tool WHERE day < ? AND calls > 0 GROUP BY day,name
      UNION ALL SELECT day,j.value,count(*) FROM tool_detail v,json_each(v.names) j WHERE v.at >= ? AND v.at < ? GROUP BY day,j.value`
    for (const row of this.db.prepare(sql).iterate(today, today, asOf)) yield { day: Number(row.day), name: String(row.name), calls: Number(row.calls) }
  }
  trackedSessions() { return new Set(this.db.prepare('SELECT DISTINCT session FROM model').all().map(row => String(row.session))) }
  latency(asOf: number, field: 'first_text' | 'queue' | 'duration' = 'first_text', from = MIN_AT, scope?: QualityScope) {
    const { where, args } = qualityFilter(asOf, from, scope)
    const samples = Number(this.db.prepare(`SELECT count(*) AS n FROM model ${where} AND ${field} IS NOT NULL`).get(...args)?.n)
    const quantile = (q: number) => samples ? Number(this.db.prepare(`SELECT ${field} AS ms FROM model ${where} AND ${field} IS NOT NULL ORDER BY ${field} LIMIT 1 OFFSET ?`).get(...args, Math.ceil(samples * q) - 1)?.ms) : null
    return { samples, p50Ms: quantile(.50), p95Ms: quantile(.95) }
  }
  profile(session: string, from: number, asOf: number) {
    // JS -Infinity means all dated events; min safe integer is below Date's supported range.
    const begin = from === -Infinity ? Number.MIN_SAFE_INTEGER : from
    const row = this.db.prepare(`SELECT count(*) AS calls, count(json_extract(usage,'$.totalTokens')) AS known,
      sum(json_extract(usage,'$.promptTokens')) AS input, sum(json_extract(usage,'$.completionTokens')) AS output,
      sum(json_extract(usage,'$.totalTokens')) AS total FROM model WHERE session=? AND at>=? AND at<?`).get(session, begin, asOf)!
    const tools = this.db.prepare('SELECT count(*) AS calls FROM tool WHERE session=? AND at>=? AND at<?').get(session, begin, asOf)!
    return { calls: Number(row.calls), known: Number(row.known), input: row.input as number | null,
      output: row.output as number | null, total: row.total as number | null, tools: Number(tools.calls),
      tracked: !!this.db.prepare('SELECT 1 FROM model WHERE session=? LIMIT 1').get(session) }
  }
  private outputRate(asOf: number, from: number, scope?: QualityScope) {
    const { where, args } = qualityFilter(asOf, from, scope)
    // Use the successful attempt's own clock, not the logical duration (which can include retries).
    const row = this.db.prepare(`WITH streams AS (
      SELECT json_extract(usage,'$.completionTokens') AS tokens,
        json_extract(attempts,'$[#-1].durationMs') - json_extract(attempts,'$[#-1].firstTextMs') AS generationMs
      FROM model ${where} AND outcome='success' AND text_observation='stream_text'
        AND json_extract(attempts,'$[#-1].outcome')='success'
    ) SELECT count(*) AS samples, total(tokens) AS tokens, total(generationMs) AS generationMs
      FROM streams WHERE tokens > 0 AND generationMs > 0`).get(...args)!
    const samples = Number(row.samples)
    const outputTokens = Number(row.tokens), activeDurationMs = Number(row.generationMs)
    const rate = outputTokens / (activeDurationMs / 1000)
    return { samples, outputTokens, activeDurationMs, tokensPerSecond: samples && Number.isFinite(rate) ? rate : null }
  }
  requestSummary(asOf: number, from = MIN_AT, scope?: QualityScope): RequestQuality {
    const { where, args } = qualityFilter(asOf, from, scope)
    const outcomes = this.db.prepare(`SELECT coalesce(outcome,'unknown') AS outcome,count(*) AS requests,
      sum(json_array_length(attempts)) AS observedAttempts, count(attempts) AS requestsWithAttempts
      FROM model ${where} GROUP BY 1 ORDER BY 1`).all(...args).map(row => ({ outcome: String(row.outcome), requests: Number(row.requests),
      observedAttempts: row.observedAttempts === null ? null : Number(row.observedAttempts), requestsWithAttempts: Number(row.requestsWithAttempts) }))
    const textObservations = this.db.prepare(`SELECT coalesce(text_observation,'unknown') AS observation,count(*) AS requests
      FROM model ${where} GROUP BY 1 ORDER BY 1`).all(...args).map(row => ({ observation: String(row.observation), requests: Number(row.requests) }))
    const cacheRow = this.db.prepare(`SELECT sum(json_extract(usage,'$.cachedTokens')) AS readTokens,
      sum(json_extract(usage,'$.promptTokens')) AS inputTokens, count(json_extract(usage,'$.promptTokens')) AS requestsWithInputTokens,
      sum(json_extract(usage,'$.completionTokens')) AS outputTokens, count(json_extract(usage,'$.completionTokens')) AS requestsWithOutputTokens,
      count(json_extract(usage,'$.cachedTokens')) AS requestsWithReadTokens,
      sum(json_extract(usage,'$.cacheWriteTokens')) AS writeTokens,
      count(json_extract(usage,'$.cacheWriteTokens')) AS requestsWithWriteTokens FROM model ${where}`).get(...args)!
    const known = (key: string) => typeof cacheRow[key] === 'number' ? cacheRow[key] : null
    const cache = { readTokens: known('readTokens'), writeTokens: known('writeTokens'), inputTokens: known('inputTokens'), outputTokens: known('outputTokens'),
      requestsWithReadTokens: Number(cacheRow.requestsWithReadTokens), requestsWithWriteTokens: Number(cacheRow.requestsWithWriteTokens),
      requestsWithInputTokens: Number(cacheRow.requestsWithInputTokens), requestsWithOutputTokens: Number(cacheRow.requestsWithOutputTokens) }
    return { asOf: new Date(asOf).toISOString(), coverage: this.complete ? 'complete' : 'partial', outcomes, textObservations, cache,
      firstText: this.latency(asOf, 'first_text', from, scope), queue: this.latency(asOf, 'queue', from, scope),
      duration: this.latency(asOf, 'duration', from, scope), outputRate: this.outputRate(asOf, from, scope) }
  }
  requestProjections(asOf: number, today: number, past7Days: number, month: number, signal?: AbortSignal): RequestQualityByPeriod {
    const period = (from: number) => {
      const { where, args } = qualityFilter(asOf, from)
      const summary = (scope?: QualityScope) => {
        signal?.throwIfAborted()
        return this.requestSummary(asOf, from, scope)
      }
      const models = this.db.prepare(`SELECT provider,quality_model FROM model ${where}
        GROUP BY provider,quality_model ORDER BY count(*) DESC,provider,quality_model`).all(...args).map(row => {
        const scope = { provider: text(row.provider), model: text(row.quality_model) }
        return { ...scope, quality: summary(scope) }
      })
      const providers = this.db.prepare(`SELECT provider FROM model ${where}
        GROUP BY provider ORDER BY count(*) DESC,provider`).all(...args).map(row => {
        const scope = { provider: text(row.provider) }
        return { ...scope, quality: summary(scope) }
      })
      return { ...summary(), models, providers }
    }
    return { total: period(MIN_AT), today: period(today), past7Days: period(past7Days), month: period(month) }
  }
  *records(session?: string, modelFrom?: number): Iterable<Row> {
    const filter = session === undefined ? '' : ' WHERE session=?'
    const args = session === undefined ? [] : [session]
    for (const row of this.db.prepare(`SELECT * FROM model${modelFrom === undefined ? filter : ' WHERE at IS NULL OR at >= ?'}`).iterate(...(modelFrom === undefined ? args : [modelFrom]))) {
      yield { type: 'model_usage', id: row.id, sessionId: row.session, timestamp: row.at === null ? undefined : new Date(Number(row.at)).toISOString(),
        model: row.model, usage: JSON.parse(String(row.usage)), durationMs: row.duration }
    }
    if (modelFrom !== undefined) return
    for (const row of this.db.prepare(`SELECT session,id,at,names FROM tool_detail${filter}`).iterate(...args)) {
      yield { role: 'tool', sessionId: row.session, tool_call_id: row.id, timestamp: row.at === null ? undefined : new Date(Number(row.at)).toISOString(), indexedToolNames: JSON.parse(String(row.names)) }
    }
  }
}

export function toolNames(name: unknown, args: unknown, depth = 0): string[] {
  if (depth >= 8 || typeof name !== 'string' || !/^[\w.:-]{1,256}$/.test(name)) return []
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
  const parameters = args as { name?: unknown; tool_uses?: unknown } | undefined
  if (name === 'invoke_tool' || name === 'functions.invoke_tool') return typeof parameters?.name === 'string' && /^[\w.:-]{1,256}$/.test(parameters.name) ? [parameters.name] : []
  if (name === 'multi_tool_use.parallel' || name === 'multi_tool_use') return Array.isArray(parameters?.tool_uses)
    ? parameters.tool_uses.flatMap(call => toolNames(call?.recipient_name, call?.parameters, depth + 1)) : []
  return [name.startsWith('functions.') ? name.slice('functions.'.length) : name]
}
