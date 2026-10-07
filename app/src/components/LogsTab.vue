<template>
  <section class="grid gap-3 lg:grid-cols-[0.4fr_1.6fr]">
    <div
      class="rounded-md border border-default bg-surface p-4 lg:sticky lg:top-10 lg:h-[calc(100vh-5rem)]">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-600">{{ t('Log Stream') }}</h2>
        <div class="flex items-center gap-2 text-xs text-ink/60">
          <span class="tag" :class="{ active: connected && !error && !windowFull }">{{ error ? t('Needs retry') : windowFull ? t('Paused') : connected ? t('Live') : t('Connecting...') }}</span>
        </div>
      </div>
      <p class="mt-2 text-sm text-ink/60">{{ t('Live tail of logs. Newest entries appear at the top.') }}</p>
      <div v-if="error" role="alert" class="mt-3 text-sm">
        {{ error }} <button class="btn ghost" @click="retryLogs">{{ t('Retry logs') }}</button>
      </div>
      <div v-if="windowFull" role="status" class="mt-3 text-sm">
        {{ t('Live buffer full. Older pages and selection are preserved.') }}
        <button class="btn ghost" @click="refreshLogs">{{ t('Load latest logs') }}</button>
      </div>

      <div class="mt-4">
        <div v-if="loading" role="status" class="text-sm text-ink/60">{{ t('Loading logs…') }}</div>
        <div v-if="logEntries.length === 0 && !loading && !error" class="text-ink/40">{{ t('No logs yet.') }}</div>
        <LogList v-else :entries="logEntries" :selected-id="selectedLog?.id" :height="560" @select="selectLog"
          @load-more="loadMoreLogs" />
      </div>
    </div>

    <div class="rounded-md border border-default bg-surface p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-600">{{ t('Log Details') }}</h2>
        <button class="btn ghost" @click="selectedLog = null">{{ t('Clear') }}</button>
      </div>
      <p class="mt-2 text-sm text-ink/60">{{ t('Click a log entry to inspect full payload.') }}</p>

      <div v-if="!selectedLog" class="mt-4 text-sm text-ink/50">{{ t('Select a log entry to inspect details.') }}</div>
      <div v-else class="detail-card mono mt-4 selectable-text">
        <!-- Severity badge + timestamp row -->
        <div class="flex items-center gap-2">
          <span class="severity-badge" :class="severityClass">{{ severityLabel }}</span>
          <span class="text-xs text-ink/50">{{ selectedLog.time ?? t('unknown') }}</span>
          <span v-if="selectedLog.module" class="text-xs text-ink/40">{{ selectedLog.module }}</span>
        </div>

        <!-- Body / message -->
        <div class="log-body-block">
          <pre class="log-body-pre">{{ selectedLog.msg }}</pre>
        </div>

        <!-- Trace context -->
        <div v-if="selectedParsed?.trace_id || selectedParsed?.span_id" class="detail-section">
          <div class="detail-section-title">{{ t('Trace Context') }}</div>
          <div v-if="selectedParsed?.trace_id" class="detail-row">
            <span>{{ t('Trace ID') }}</span>
            <code class="text-xs">{{ selectedParsed.trace_id }}</code>
          </div>
          <div v-if="selectedParsed?.span_id" class="detail-row">
            <span>{{ t('Span ID') }}</span>
            <code class="text-xs">{{ selectedParsed.span_id }}</code>
          </div>
        </div>

        <!-- Attributes -->
        <div v-if="selectedAttributes && Object.keys(selectedAttributes).length" class="detail-section">
          <div class="detail-section-title">{{ t('Attributes') }}</div>
          <div v-for="(val, key) in selectedAttributes" :key="key" class="detail-row">
            <span>{{ key }}</span>
            <strong class="text-xs break-all">{{ val }}</strong>
          </div>
        </div>

        <!-- Resource / Scope -->
        <div v-if="selectedResource" class="detail-section">
          <div class="detail-section-title">{{ t('Resource') }}</div>
          <div v-for="(val, key) in selectedResource" :key="key" class="detail-row">
            <span>{{ key }}</span>
            <strong class="text-xs break-all">{{ val }}</strong>
          </div>
        </div>

        <div v-if="isTraceLog" class="trace-stack">
          <div class="trace-section">
            <div class="trace-title">{{ t('LLM Request') }}</div>
            <div v-if="traceRequestMessages.length" class="trace-messages">
              <div v-for="(msg, i) in traceRequestMessages" :key="i" class="trace-msg">
                <span class="trace-msg-role">{{ messageRoleLabel(msg) }}</span>
                <span v-if="messageRoleLabel(msg) !== msg.role" class="trace-msg-protocol">{{ t('Model role:') }} {{ msg.role }}</span>
                <pre class="trace-msg-content">{{ typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }}</pre>
                <div v-if="msg.tool_calls?.length" class="trace-msg-tools">
                  <div v-for="tc in msg.tool_calls" :key="tc.id" class="trace-msg-tool">
                    <strong>{{ tc.function.name }}</strong>
                    <pre>{{ tc.function.arguments }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-ink/50">{{ t('No request messages captured.') }}</div>
          </div>
          <div class="trace-section">
            <div class="trace-title">{{ t('LLM Response') }}</div>
            <div v-if="traceResponseMessages.length" class="trace-messages">
              <div v-for="(msg, i) in traceResponseMessages" :key="i" class="trace-msg">
                <span class="trace-msg-role">{{ messageRoleLabel(msg) }}</span>
                <span v-if="messageRoleLabel(msg) !== msg.role" class="trace-msg-protocol">{{ t('Model role:') }} {{ msg.role }}</span>
                <pre class="trace-msg-content">{{ typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }}</pre>
                <div v-if="msg.tool_calls?.length" class="trace-msg-tools">
                  <div v-for="tc in msg.tool_calls" :key="tc.id" class="trace-msg-tool">
                    <strong>{{ tc.function.name }}</strong>
                    <pre>{{ tc.function.arguments }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-ink/50">{{ t('No response content captured.') }}</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
import { messageRoleLabel } from '../message-author.ts'
import { apiUrl } from '../api-url.ts'
import { computed, ref, watch } from 'vue'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import LogList, { type LogEntry } from './LogList.vue'

export type PromptMessage = {
  role: string
  content: string | Array<{ type: string; text?: string }> | null
  name?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

const props = defineProps<{ apiBase: string }>()
const emit = defineEmits<{ (e: 'update:logCount', count: number): void }>()

const logEntries = ref<LogEntry[]>([])
const selectedLog = ref<LogEntry | null>(null)
const connected = ref(false)
const loading = ref(false)
const hasMore = ref(true)

const pool = useLiveClientPool()
const error = ref('')
const windowFull = ref(false)
let refreshLogs = () => {}
let retryLogs = () => {}
let loadMoreLogs = async () => {}
let logSeq = 0
const PAGE_SIZE = 20
const LIVE_LIMIT = 1000

const isTraceLog = computed(() => selectedLog.value?.kind === 'trace')

// ─── Detail panel computed ────────────────────────────────────────────────

const selectedParsed = computed(() => selectedLog.value?.parsed as Record<string, unknown> | undefined)

const selectedAttributes = computed<Record<string, string>>(() => {
  const p = selectedParsed.value
  if (!p) return {}
  return (p._attributes as Record<string, string>) ?? {}
})

const selectedResource = computed<Record<string, string>>(() => {
  const p = selectedParsed.value
  if (!p?.resource) return {}
  try {
    const res = typeof p.resource === 'string' ? JSON.parse(p.resource) : p.resource
    const attrs = res?.attributes
    if (!Array.isArray(attrs)) return {}
    const map: Record<string, string> = {}
    for (const a of attrs) {
      if (a?.key) {
        const v = unwrapAnyValue(a.value)
        map[String(a.key)] = typeof v === 'string' ? v : JSON.stringify(v)
      }
    }
    return map
  } catch { return {} }
})

const SEVERITY_LABELS: Record<number, string> = {
  1: 'TRACE', 2: 'TRACE', 3: 'TRACE', 4: 'TRACE',
  5: 'DEBUG', 6: 'DEBUG', 7: 'DEBUG', 8: 'DEBUG',
  9: 'INFO', 10: 'INFO', 11: 'INFO', 12: 'INFO',
  13: 'WARN', 14: 'WARN', 15: 'WARN', 16: 'WARN',
  17: 'ERROR', 18: 'ERROR', 19: 'ERROR', 20: 'ERROR',
  21: 'FATAL', 22: 'FATAL', 23: 'FATAL', 24: 'FATAL',
}

const severityLabel = computed(() => {
  const lvl = selectedLog.value?.level
  if (lvl == null) return 'LOG'
  return (selectedParsed.value?.severity_text as string) ?? SEVERITY_LABELS[lvl] ?? `SEV${lvl}`
})

const severityClass = computed(() => {
  const lvl = selectedLog.value?.level
  if (lvl == null) return 'sev-info'
  if (lvl >= 17) return 'sev-error'
  if (lvl >= 13) return 'sev-warn'
  if (lvl >= 9) return 'sev-info'
  if (lvl >= 5) return 'sev-debug'
  return 'sev-trace'
})

const traceRequestMessages = computed<PromptMessage[]>(() => {
  const log = selectedLog.value
  if (!log || log.kind !== 'trace') return []
  const parsed = log.parsed as Record<string, unknown> | undefined
  const request = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).request : undefined
  const messages = request && typeof request === 'object' ? (request as Record<string, unknown>).messages : undefined
  return toPromptMessages(messages)
})

const traceResponseMessages = computed<PromptMessage[]>(() => {
  const log = selectedLog.value
  if (!log || log.kind !== 'trace') return []
  const parsed = log.parsed as Record<string, unknown> | undefined
  const response = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).response : undefined
  const content = response && typeof response === 'object' ? (response as Record<string, unknown>).content : undefined
  const toolCalls = response && typeof response === 'object' ? (response as Record<string, unknown>).toolCalls : undefined
  const mappedToolCalls = mapToolCalls(toolCalls)
  if ((content === undefined || content === null || String(content).length === 0) && (!mappedToolCalls || mappedToolCalls.length === 0)) return []
  return [{ role: 'assistant', content: content == null ? '' : String(content), tool_calls: mappedToolCalls }]
})

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validatedLog(value: unknown): LogEntry {
  if (!record(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0
    || typeof value.time !== 'number' || !Number.isFinite(value.time) || !('body' in value)) {
    throw new Error(t('Invalid log record received.'))
  }
  for (const key of ['attributes', 'resource', 'scope']) {
    const raw = value[key]
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed == null) continue
    if (key === 'attributes'
      ? !Array.isArray(parsed) || !parsed.every(item => record(item) && typeof item.key === 'string')
      : !record(parsed)) throw new Error(t('Invalid log {key}.', { key: key }))
  }
  return apiEntryToLogEntry(value)
}

function mergeLogs(entries: LogEntry[]): LogEntry[] {
  return [...new Map(entries.map(entry => [entry.id, entry])).values()]
    .sort((a, b) => (b.dbId ?? 0) - (a.dbId ?? 0))
}

watch(() => props.apiBase, (base, _previous, onCleanup) => {
  const scope = new AbortController()
  let page: AbortController | undefined
  let automaticCount = 0
  let buffering = true
  let retryPage = false
  const pending = new Map<string, LogEntry>()
  logEntries.value = []
  selectedLog.value = null
  error.value = ''
  windowFull.value = false
  hasMore.value = true
  loading.value = true
  connected.value = false

  async function query(signal: AbortSignal, beforeId?: number) {
    const url = apiUrl(base, '/v1/query/logs')
    url.searchParams.set('limit', String(PAGE_SIZE))
    if (beforeId !== undefined) url.searchParams.set('beforeId', String(beforeId))
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(t('Log query failed ({status}).', { status: response.status }))
    const data: unknown = await response.json()
    if (!record(data) || !Array.isArray(data.entries) || typeof data.total !== 'number' || !Number.isFinite(data.total)) {
      throw new Error(t('Invalid log query response.'))
    }
    return { entries: data.entries.map(validatedLog), total: data.total }
  }
  const snapshot = createLiveRefresh({
    load: signal => {
      buffering = true
      loading.value = true
      return query(signal)
    },
    apply: data => {
      const merged = mergeLogs([...data.entries, ...pending.values()])
      logEntries.value = merged.slice(0, LIVE_LIMIT)
      automaticCount = logEntries.value.length
      windowFull.value = merged.length >= LIVE_LIMIT
      pending.clear()
      buffering = false
      hasMore.value = data.entries.length < data.total
      loading.value = false
      error.value = ''
    },
    onError: () => {
      loading.value = false
      error.value = t('Could not load saved logs. Check Main and retry.')
    },
  })
  refreshLogs = () => {
    page?.abort()
    page = undefined
    retryPage = false
    pending.clear()
    buffering = true
    loading.value = true
    snapshot.refresh()
  }
  loadMoreLogs = async () => {
    if (loading.value || !hasMore.value || !logEntries.value.length) return
    const beforeId = logEntries.value.at(-1)?.dbId
    if (beforeId === undefined) return
    const current = new AbortController()
    page = current
    const signal = AbortSignal.any([scope.signal, current.signal, AbortSignal.timeout(15_000)])
    loading.value = true
    try {
      const data = await query(signal, beforeId)
      signal.throwIfAborted()
      logEntries.value = mergeLogs([...logEntries.value, ...data.entries])
      hasMore.value = data.entries.length >= PAGE_SIZE
      retryPage = false
      error.value = ''
    } catch {
      if (!scope.signal.aborted && !current.signal.aborted) {
        retryPage = true
        error.value = t('Could not load older logs. Retry to keep browsing.')
      }
    } finally {
      if (page === current) {
        page = undefined
        loading.value = false
      }
    }
  }
  retryLogs = () => { if (retryPage) void loadMoreLogs(); else refreshLogs() }
  const subscription = pool.client(base).subscribe({
    kind: 'logs', projectId: liveProjectId(base),
  }, {
    event: envelope => {
      try {
        const entry = validatedLog(envelope.payload)
        if (buffering) {
          pending.set(entry.id, entry)
          if (pending.size > LIVE_LIMIT) pending.delete(pending.keys().next().value!)
        } else if (logEntries.value.some(item => item.id === entry.id)) {
          return
        } else if (automaticCount < LIVE_LIMIT) {
          automaticCount++
          logEntries.value = [entry, ...logEntries.value]
        } else {
          // Freeze the contiguous window rather than evicting explicitly loaded history.
          windowFull.value = true
        }
      } catch {
        error.value = t('Could not read a live log. Retry logs to reload saved state.')
      }
    },
    reset: () => refreshLogs(),
  })
  const observe = pool.observe(statuses => {
    connected.value = statuses.length > 0 && statuses.every(status => status.phase === 'live')
  })
  snapshot.refresh()
  onCleanup(() => {
    subscription.close()
    scope.abort()
    page?.abort()
    snapshot.dispose()
    observe()
    pending.clear()
  })
}, { immediate: true })

function selectLog(entry: LogEntry): void {
  selectedLog.value = entry
}

function toPromptMessages(value: unknown): PromptMessage[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') return null
    const msg = entry as Record<string, unknown>
    const role = typeof msg.role === 'string' ? msg.role : 'system'
    const content = msg.content == null ? '' : String(msg.content)
    const name = typeof msg.name === 'string' ? msg.name : undefined
    const tool_call_id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined
    const tool_calls = mapToolCalls(msg.tool_calls, index)
    return { role, content, name, tool_call_id, tool_calls }
  }).filter(Boolean) as PromptMessage[]
}

function mapToolCalls(value: unknown, seed = 0): PromptMessage['tool_calls'] {
  if (!Array.isArray(value)) return undefined
  const mapped = value.map((tool, index) => {
    if (!tool || typeof tool !== 'object') return null
    const tc = tool as Record<string, unknown>
    const fn = tc.function as Record<string, unknown> | undefined
    const name = typeof tc.name === 'string'
      ? tc.name
      : typeof fn?.name === 'string'
        ? fn.name
        : 'tool'
    const rawArgs = fn?.arguments ?? (tc as Record<string, unknown>).arguments
    const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
    const id = typeof tc.id === 'string' ? tc.id : `tool-${seed}-${index}`
    return { id, type: 'function', function: { name, arguments: args } }
  }).filter((x): x is { id: string; type: string; function: { name: string; arguments: string } } => x !== null)
  return mapped.length ? mapped : undefined
}

function toLogEntry(line: string): LogEntry {
  logSeq += 1
  const id = `log-${logSeq}`
  const parsed = safeParseJson(line)
  if (!parsed) {
    return { id, raw: line, kind: 'log', summary: line.slice(0, 120), msg: line }
  }

  const msg = typeof parsed.msg === 'string' ? parsed.msg : 'log'
  const module = typeof parsed.module === 'string' ? parsed.module : undefined
  const time = formatTime(parsed.time)
  const kind = msg.includes('llm-trace') ? 'trace' : 'log'

  return {
    id,
    raw: line,
    parsed,
    level: typeof parsed.level === 'number' ? parsed.level : undefined,
    msg,
    module,
    time,
    kind,
    summary: kind === 'trace' ? buildTraceSummary(parsed) : buildLogSummary(msg, parsed),
  }
}

/**
 * Unwrap an OTLP AnyValue to a plain JS value.
 * AnyValue can be: { stringValue }, { intValue }, { doubleValue }, { boolValue },
 *                  { arrayValue: { values: [...] } }, { kvlistValue: { values: [...] } },
 *                  { bytesValue }
 */
function unwrapAnyValue(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'string') {
    // May be JSON-stringified AnyValue from SQLite
    try { return unwrapAnyValue(JSON.parse(v)) } catch { return v }
  }
  if (typeof v !== 'object') return v
  const obj = v as Record<string, unknown>
  if ('stringValue' in obj) return obj.stringValue
  if ('intValue' in obj) return Number(obj.intValue)
  if ('doubleValue' in obj) return Number(obj.doubleValue)
  if ('boolValue' in obj) return Boolean(obj.boolValue)
  if ('bytesValue' in obj) return obj.bytesValue
  if ('arrayValue' in obj) {
    const arr = (obj.arrayValue as Record<string, unknown>)?.values
    return Array.isArray(arr) ? arr.map(unwrapAnyValue) : []
  }
  if ('kvlistValue' in obj) {
    const kvs = (obj.kvlistValue as Record<string, unknown>)?.values
    if (Array.isArray(kvs)) {
      const out: Record<string, unknown> = {}
      for (const kv of kvs) {
        const k = (kv as Record<string, unknown>)?.key as string
        if (k) out[k] = unwrapAnyValue((kv as Record<string, unknown>).value)
      }
      return out
    }
    return {}
  }
  return v
}

/**
 * Parse OTLP attributes array (stored as JSON string) into a flat key→string map.
 */
function parseOtelAttributes(raw: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  let attrs: unknown[] = []
  if (typeof raw === 'string') {
    try { attrs = JSON.parse(raw) } catch { /* ignore */ }
  } else if (Array.isArray(raw)) {
    attrs = raw
  }
  for (const a of attrs) {
    const item = a as Record<string, unknown>
    if (item?.key) {
      const val = unwrapAnyValue(item.value)
      map[String(item.key)] = typeof val === 'string' ? val : JSON.stringify(val)
    }
  }
  return map
}

/**
 * Convert an API entry (otel_logs row from SQLite) to LogEntry format.
 * otel_logs schema: id, time, observed_time, severity, severity_text, body, attributes, trace_id, span_id, resource, scope
 */
function apiEntryToLogEntry(entry: Record<string, unknown>): LogEntry {
  const id = `log-${entry.id}`
  const dbId = typeof entry.id === 'number' ? entry.id : undefined

  // Unwrap OTLP AnyValue body → plain string
  const bodyVal = unwrapAnyValue(entry.body)
  const msg = typeof bodyVal === 'string' ? bodyVal.replace(/\n$/, '') : (bodyVal != null ? JSON.stringify(bodyVal) : 'log')

  // Parse attributes JSON to extract module and other fields
  const attrMap = parseOtelAttributes(entry.attributes)

  // Module: try attributes, then scope name
  let mod = attrMap['module'] ?? attrMap['log.module'] ?? attrMap['code.namespace']
  if (!mod && typeof entry.scope === 'string') {
    try { mod = JSON.parse(entry.scope)?.name } catch { /* ignore */ }
  }

  // time: otel_logs stores millisecond epoch (converted from nano at ingest)
  const rawTime = entry.time
  const time = formatTime(typeof rawTime === 'number' && rawTime > 1e15 ? rawTime / 1e6 : rawTime)

  // severity: OTLP severity number (1-24)
  const severity = typeof entry.severity === 'number' ? entry.severity : undefined
  const level = severity

  const kind = msg.includes('llm-trace') ? 'trace' : 'log'

  return {
    id,
    dbId,
    raw: JSON.stringify(entry),
    parsed: { ...entry, _body: msg, _attributes: attrMap },
    level,
    msg,
    module: mod,
    time,
    kind,
    summary: kind === 'trace' ? buildTraceSummary(entry) : buildLogSummary(msg, entry),
  }
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed) as Record<string, unknown>
      } catch {
        return null
      }
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function formatTime(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return formatDateTime(new Date(value), { hourCycle: 'h23', ...{ hour: '2-digit', minute: '2-digit', second: '2-digit' } })
  }
  if (typeof value === 'string') return value
  return undefined
}

function buildLogSummary(msg: string, parsed: Record<string, unknown>): string {
  if (typeof parsed.err === 'string') {
    return `${msg}: ${parsed.err}`
  }
  if (typeof parsed.error === 'string') {
    return `${msg}: ${parsed.error}`
  }
  return msg
}

function buildTraceSummary(parsed: Record<string, unknown>): string {
  const provider = typeof parsed.provider === 'string' ? parsed.provider : 'llm'
  const model = typeof parsed.responseModel === 'string'
    ? parsed.responseModel
    : typeof parsed.requestedModel === 'string'
      ? parsed.requestedModel
      : 'unknown-model'
  const duration = typeof parsed.durationMs === 'number' ? t('{durationMs}ms', { durationMs: parsed.durationMs }) : ''
  return `${provider} ${model} ${duration}`.trim()
}

watch(() => logEntries.value.length, (count) => {
  emit('update:logCount', count)
})

defineExpose({ logCount: computed(() => logEntries.value.length) })
</script>

<style scoped>
.tag {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 0.1rem 0.4rem;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: var(--c-bg-soft);
  color: var(--c-text-body);
}

.tag.active {
  background: var(--c-primary-bg);
  color: white;
  border-color: var(--c-text);
}

.btn.ghost {
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  cursor: pointer;
  transition: background 0.1s ease;
}

.btn.ghost:hover {
  background: var(--c-bg-muted);
}

.detail-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.75rem;
  background: var(--c-bg-card);
  display: grid;
  gap: 0.5rem;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: var(--c-text-body);
}

.detail-row strong {
  color: var(--c-text);
}

.trace-stack {
  display: grid;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
}

.trace-section {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.5rem;
  background: var(--c-bg-card);
  display: grid;
  gap: 0.5rem;
}

.trace-title {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
  font-weight: 600;
}

.severity-badge {
  display: inline-block;
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
}

.sev-trace, .sev-debug { background: var(--c-bg-muted); color: var(--c-text-muted); }
.sev-info { background: var(--c-bg-muted); color: var(--c-text-secondary); }
.sev-warn { background: var(--c-warn-bg); color: var(--c-warn); }
.sev-error { background: var(--c-error-bg); color: var(--c-error); }

.log-body-block {
  background: var(--c-bg-soft);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  padding: 0.5rem 0.6rem;
  overflow-x: auto;
}

.log-body-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--c-text);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.detail-section {
  border-top: 1px solid var(--c-border);
  padding-top: 0.5rem;
  display: grid;
  gap: 0.3rem;
}

.detail-section-title {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
  font-weight: 600;
  margin-bottom: 0.15rem;
}

.trace-messages {
  display: grid;
  gap: 0.35rem;
}

.trace-msg {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  padding: 0.4rem 0.5rem;
  background: var(--c-bg-card);
}

.trace-msg-role {
  display: inline-block;
  font-size: 0.55rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
  margin-bottom: 0.15rem;
}

.trace-msg-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.7rem;
  line-height: 1.4;
  color: var(--c-text-secondary);
  max-height: 200px;
  overflow: auto;
}

.trace-msg-protocol { margin-left: 8px; color: var(--c-text-secondary); font-size: 11px; }

.trace-msg-tools {
  margin-top: 0.25rem;
  padding-top: 0.25rem;
  border-top: 1px solid var(--c-border);
}

.trace-msg-tool {
  font-size: 0.65rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: var(--c-text-body);
}

.trace-msg-tool pre {
  margin: 0.1rem 0 0;
  font-size: 0.6rem;
  max-height: 120px;
  overflow: auto;
}
</style>
