<template>
  <section class="grid gap-3 lg:grid-cols-[0.4fr_1.6fr]">
    <div
      class="rounded-md border border-default bg-surface p-4 lg:sticky lg:top-10 lg:h-[calc(100vh-5rem)]">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-600">Log Stream</h2>
        <div class="flex items-center gap-2 text-xs text-ink/60">
          <span class="tag" :class="{ active: connected }">{{ connected ? 'Live' : 'Connecting...' }}</span>
        </div>
      </div>
      <p class="mt-2 text-sm text-ink/60">Live tail of logs. Newest entries appear at the top.</p>

      <div class="mt-4">
        <div v-if="logEntries.length === 0" class="text-ink/40">No logs yet.</div>
        <LogList v-else :entries="logEntries" :selected-id="selectedLog?.id" :height="560" @select="selectLog"
          @load-more="loadMoreLogs" />
      </div>
    </div>

    <div class="rounded-md border border-default bg-surface p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-600">Log Details</h2>
        <button class="btn ghost" @click="selectedLog = null">Clear</button>
      </div>
      <p class="mt-2 text-sm text-ink/60">Click a log entry to inspect full payload.</p>

      <div v-if="!selectedLog" class="mt-4 text-sm text-ink/50">Select a log entry to inspect details.</div>
      <div v-else class="detail-card mono mt-4">
        <!-- Severity badge + timestamp row -->
        <div class="flex items-center gap-2">
          <span class="severity-badge" :class="severityClass">{{ severityLabel }}</span>
          <span class="text-xs text-ink/50">{{ selectedLog.time ?? 'unknown' }}</span>
          <span v-if="selectedLog.module" class="text-xs text-ink/40">{{ selectedLog.module }}</span>
        </div>

        <!-- Body / message -->
        <div class="log-body-block">
          <pre class="log-body-pre">{{ selectedLog.msg }}</pre>
        </div>

        <!-- Trace context -->
        <div v-if="selectedParsed?.trace_id || selectedParsed?.span_id" class="detail-section">
          <div class="detail-section-title">Trace Context</div>
          <div v-if="selectedParsed?.trace_id" class="detail-row">
            <span>Trace ID</span>
            <code class="text-xs">{{ selectedParsed.trace_id }}</code>
          </div>
          <div v-if="selectedParsed?.span_id" class="detail-row">
            <span>Span ID</span>
            <code class="text-xs">{{ selectedParsed.span_id }}</code>
          </div>
        </div>

        <!-- Attributes -->
        <div v-if="selectedAttributes && Object.keys(selectedAttributes).length" class="detail-section">
          <div class="detail-section-title">Attributes</div>
          <div v-for="(val, key) in selectedAttributes" :key="key" class="detail-row">
            <span>{{ key }}</span>
            <strong class="text-xs break-all">{{ val }}</strong>
          </div>
        </div>

        <!-- Resource / Scope -->
        <div v-if="selectedResource" class="detail-section">
          <div class="detail-section-title">Resource</div>
          <div v-for="(val, key) in selectedResource" :key="key" class="detail-row">
            <span>{{ key }}</span>
            <strong class="text-xs break-all">{{ val }}</strong>
          </div>
        </div>

        <div v-if="isTraceLog" class="trace-stack">
          <div class="trace-section">
            <div class="trace-title">LLM Request</div>
            <div v-if="traceRequestMessages.length" class="trace-messages">
              <div v-for="(msg, i) in traceRequestMessages" :key="i" class="trace-msg">
                <span class="trace-msg-role">{{ msg.role }}</span>
                <pre class="trace-msg-content">{{ typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }}</pre>
                <div v-if="msg.tool_calls?.length" class="trace-msg-tools">
                  <div v-for="tc in msg.tool_calls" :key="tc.id" class="trace-msg-tool">
                    <strong>{{ tc.function.name }}</strong>
                    <pre>{{ tc.function.arguments }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-ink/50">No request messages captured.</div>
          </div>
          <div class="trace-section">
            <div class="trace-title">LLM Response</div>
            <div v-if="traceResponseMessages.length" class="trace-messages">
              <div v-for="(msg, i) in traceResponseMessages" :key="i" class="trace-msg">
                <span class="trace-msg-role">{{ msg.role }}</span>
                <pre class="trace-msg-content">{{ typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }}</pre>
                <div v-if="msg.tool_calls?.length" class="trace-msg-tools">
                  <div v-for="tc in msg.tool_calls" :key="tc.id" class="trace-msg-tool">
                    <strong>{{ tc.function.name }}</strong>
                    <pre>{{ tc.function.arguments }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-ink/50">No response content captured.</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { apiUrl } from '../api-url.ts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

let eventSource: EventSource | null = null
let reconnectTimer: number | null = null
let logSeq = 0
const PAGE_SIZE = 20

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

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = apiUrl(props.apiBase, path)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

/**
 * Load initial logs (newest first, displayed at the top).
 * Uses cursor-based pagination with the SQLite backend.
 */
async function loadInitialLogs(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    // Load newest PAGE_SIZE entries (API returns newest first by default)
    const res = await fetch(buildUrl('/v1/query/logs', { limit: String(PAGE_SIZE) }))
    const data = await res.json()
    const entries: Record<string, unknown>[] = data.entries ?? []
    const total = data.total ?? 0

    if (entries.length === 0) {
      hasMore.value = false
      return
    }

    // Convert API entries to LogEntry format
    logEntries.value = entries.map((entry) => apiEntryToLogEntry(entry))
    hasMore.value = entries.length < total
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

/**
 * Load more (older) logs when user scrolls to bottom.
 * Uses cursor-based pagination (beforeId).
 */
async function loadMoreLogs(): Promise<void> {
  if (loading.value || !hasMore.value || logEntries.value.length === 0) return
  loading.value = true
  try {
    // Get the oldest entry's ID to paginate before it
    const oldestEntry = logEntries.value[logEntries.value.length - 1]
    const oldestId = oldestEntry.dbId

    if (!oldestId) {
      hasMore.value = false
      return
    }

    const res = await fetch(buildUrl('/v1/query/logs', { beforeId: String(oldestId), limit: String(PAGE_SIZE) }))
    const data = await res.json()
    const entries: Record<string, unknown>[] = data.entries ?? []

    if (entries.length === 0) {
      hasMore.value = false
      return
    }

    // Append older entries to the end
    const newEntries = entries.map((entry) => apiEntryToLogEntry(entry))
    logEntries.value = [...logEntries.value, ...newEntries]
    hasMore.value = entries.length >= PAGE_SIZE
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

function stopStreaming(): void {
  connected.value = false
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

function startSse(): void {
  eventSource = new EventSource(buildUrl('/v1/stream/logs'))
  eventSource.addEventListener('hello', () => {
    connected.value = true
  })
  eventSource.addEventListener('log', (event) => {
    const data = (event as MessageEvent).data
    if (data) {
      try {
        const entry = JSON.parse(String(data)) as Record<string, unknown>
        // Prepend new logs to the top (newest first)
        logEntries.value = [apiEntryToLogEntry(entry), ...logEntries.value]
      } catch {
        // Ignore parse errors
      }
    }
  })
  eventSource.addEventListener('error', () => {
    stopStreaming()
    reconnectTimer = window.setTimeout(() => {
      startSse()
    }, 1500)
  })
}

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
  logSeq += 1
  const id = `log-${logSeq}`
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
    return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
  const duration = typeof parsed.durationMs === 'number' ? `${parsed.durationMs}ms` : ''
  return `${provider} ${model} ${duration}`.trim()
}

watch(() => logEntries.value.length, (count) => {
  emit('update:logCount', count)
})

onMounted(async () => {
  await loadInitialLogs()
  startSse()
})

onBeforeUnmount(() => {
  stopStreaming()
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

.sev-trace { background: var(--c-indigo-bg); color: var(--c-indigo); }
.sev-debug { background: var(--c-info-bg); color: var(--c-info); }
.sev-info { background: var(--c-success-bg); color: var(--c-teal); }
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
