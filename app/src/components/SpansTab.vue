<template>
  <section class="grid gap-3 xl:grid-cols-[0.5fr_1.5fr]">
    <div
      class="rounded-md border border-default bg-surface p-4 xl:sticky xl:top-10 xl:h-[calc(100vh-5rem)]">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-600">Trace Stream</h2>
        <div class="flex items-center gap-2 text-xs text-ink/60">
          <span class="tag" :class="{ active: connected && !error }">{{ error ? 'Needs retry' : connected ? 'Live' : 'Connecting...' }}</span>
        </div>
      </div>
      <p class="mt-2 text-sm text-ink/60">Spans grouped by trace. Pick a trace to render the full timeline.</p>
      <div v-if="error" role="alert" class="mt-3 text-sm">
        {{ error }} <button class="btn ghost" @click="refreshSpans">Retry spans</button>
      </div>
      <p v-if="windowFull" role="status" class="mt-3 text-sm text-ink/60">Showing the latest {{ LIVE_LIMIT }} spans. The selected trace is retained separately.</p>

      <div class="mt-4 grid gap-2">
        <input v-model="filters.traceId" class="input" placeholder="filter by trace id" />
        <input v-model="filters.name" class="input" placeholder="filter by span name" />
      </div>

      <div class="mt-4 trace-list">
        <div v-if="loading" role="status" class="text-sm text-ink/60">Loading spans…</div>
        <div v-if="traceSummaries.length === 0 && !loading && !error" class="text-ink/40">No spans yet.</div>
        <button
          v-for="trace in traceSummaries"
          :key="trace.traceId"
          class="trace-item"
          :class="{ active: trace.traceId === selectedTraceId }"
          type="button"
          @click="selectTrace(trace.traceId)"
        >
          <div class="trace-main">
            <div class="trace-title">{{ trace.rootName || 'root' }}</div>
            <div class="trace-meta">
              <span>{{ trace.spanCount }} spans</span>
              <span>•</span>
              <span>{{ formatDuration(trace.durationMs) }}</span>
              <span v-if="trace.errorCount" class="trace-error">• {{ trace.errorCount }} errors</span>
            </div>
          </div>
          <div class="trace-side">
            <span class="trace-time">{{ formatTime(trace.startTime) }}</span>
            <span class="trace-id">{{ trace.traceId.slice(0, 12) }}</span>
          </div>
        </button>
      </div>
    </div>

    <div class="grid gap-3">
      <div class="rounded-md border border-default bg-surface p-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-600">Trace Timeline</h2>
            <p class="mt-2 text-sm text-ink/60">Spans are rendered relative to the trace start time.</p>
          </div>
          <div class="flex items-center gap-2 text-xs text-ink/60" v-if="selectedTraceId">
            <span class="tag small">{{ selectedTraceId.slice(0, 16) }}</span>
          </div>
        </div>

        <div v-if="detailError" role="alert" class="mt-3 text-sm">
          {{ detailError }} <button class="btn ghost" @click="refreshDetails">Retry trace</button>
        </div>
        <p v-if="detailsLoading" role="status" class="mt-3 text-sm text-ink/60">Loading trace details…</p>
        <p v-if="traceLimited" role="status" class="mt-3 text-sm text-ink/60">This trace exceeds the {{ LIVE_LIMIT }} span display limit; the timeline is partial.</p>
        <div v-if="!selectedTraceId" class="mt-4 text-sm text-ink/50">Select a trace to see its timeline.</div>
        <div v-else class="timeline">
          <div class="timeline-header">
            <span>Span</span>
            <div class="timeline-ruler">
              <span v-for="tick in timelineTicks" :key="tick.label" class="ruler-tick" :style="{ left: tick.pct + '%' }">
                {{ tick.label }}
              </span>
            </div>
          </div>
          <div class="timeline-rows">
            <button
              v-for="(span, idx) in orderedSpans"
              :key="span.spanId"
              class="timeline-row"
              :class="{
                active: span.spanId === selectedSpanId,
                error: span.statusCode === 2,
                open: !span.endTime,
              }"
              :style="{ '--row-delay': idx * 30 + 'ms' }"
              type="button"
              @click="selectSpan(span.spanId)"
            >
              <div class="timeline-label" :style="{ paddingLeft: `${span.depth * 20 + 8}px` }">
                <span v-if="span.depth > 0" class="tree-connector" :style="{ left: `${(span.depth - 1) * 20 + 14}px` }"></span>
                <span class="depth-dot" :style="{ background: depthColor(span.depth) }"></span>
                <span class="span-name">{{ span.name }}</span>
                <span v-if="span.statusCode === 2" class="span-error">error</span>
                <span v-if="!span.endTime" class="span-live">live</span>
              </div>
              <div class="timeline-bar">
                <div
                  class="bar"
                  :class="{ 'bar-open': !span.endTime }"
                  :style="{ ...barStyle(span), '--bar-color': depthColor(span.depth) }"
                >
                  <span class="bar-label">{{ formatDuration(span.durationMs) }}</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div class="rounded-md border border-default bg-surface p-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-600">Span Details</h2>
            <p class="mt-2 text-sm text-ink/60">Inspect attributes, events, and logs for the selected span.</p>
          </div>
          <button class="btn ghost" @click="selectedSpanId = null">Clear</button>
        </div>

        <div v-if="!selectedSpan" class="mt-4 text-sm text-ink/50">Select a span to inspect details.</div>
        <div v-else class="detail-card mono mt-4">
          <div class="detail-row">
            <span>Name</span>
            <strong>{{ selectedSpan.name }}</strong>
          </div>
          <div class="detail-row">
            <span>Span ID</span>
            <strong class="text-xs">{{ selectedSpan.spanId }}</strong>
          </div>
          <div class="detail-row">
            <span>Parent</span>
            <strong class="text-xs">{{ selectedSpan.parentSpanId ?? 'root' }}</strong>
          </div>
          <div class="detail-row">
            <span>Duration</span>
            <strong>{{ formatDuration(spanDurationMs(selectedSpan)) }}</strong>
          </div>
          <div class="detail-row">
            <span>Status</span>
            <strong>{{ selectedSpan.statusCode === 2 ? 'error' : selectedSpan.statusCode === 1 ? 'ok' : 'unset' }}</strong>
          </div>

          <div v-if="Object.keys(selectedSpan.attributes).length" class="detail-section">
            <div class="detail-section-title">Attributes</div>
            <div v-for="(val, key) in selectedSpan.attributes" :key="key" class="detail-row">
              <span>{{ key }}</span>
              <strong class="text-xs break-all">{{ val }}</strong>
            </div>
          </div>

          <div v-if="selectedSpan.events.length" class="detail-section">
            <div class="detail-section-title">Events</div>
            <div v-for="evt in selectedSpan.events" :key="evt.id" class="event-card">
              <div class="event-header">
                <span class="event-name">{{ evt.name }}</span>
                <span class="event-time">+{{ formatDuration(evt.offsetMs) }}</span>
                <span v-if="evt.isException" class="event-tag">exception</span>
              </div>
              <div v-if="evt.exception" class="event-exception">
                <div class="exception-line">{{ evt.exception.type }}</div>
                <div class="exception-line">{{ evt.exception.message }}</div>
                <pre v-if="evt.exception.stacktrace" class="exception-trace">{{ evt.exception.stacktrace }}</pre>
              </div>
              <div v-if="Object.keys(evt.attributes).length" class="event-attrs">
                <div v-for="(val, key) in evt.attributes" :key="key" class="detail-row">
                  <span>{{ key }}</span>
                  <strong class="text-xs break-all">{{ val }}</strong>
                </div>
              </div>
            </div>
          </div>

          <div v-if="spanLogs.length" class="detail-section">
            <div class="detail-section-title">Logs</div>
            <div v-for="log in spanLogs" :key="log.id" class="event-card">
              <div class="event-header">
                <span class="event-name">{{ log.body }}</span>
                <span class="event-time">{{ formatTime(log.time) }}</span>
              </div>
              <div v-if="Object.keys(log.attributes).length" class="event-attrs">
                <div v-for="(val, key) in log.attributes" :key="key" class="detail-row">
                  <span>{{ key }}</span>
                  <strong class="text-xs break-all">{{ val }}</strong>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="detail-section">
            <div class="detail-section-title">Logs</div>
            <div class="text-xs text-ink/50">{{ detailsLoading ? 'Loading trace logs…' : detailError ? 'Trace logs unavailable. Retry trace above.' : 'No logs for this span.' }}</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { apiUrl } from '../api-url.ts'
import { computed, reactive, ref, watch } from 'vue'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
import { createLiveRefresh } from '../live-refresh.ts'

const props = defineProps<{ apiBase: string }>()

type SpanEvent = {
  id: string
  name: string
  timeMs: number
  offsetMs: number
  attributes: Record<string, string>
  isException: boolean
  exception?: { type: string; message: string; stacktrace?: string }
}

type SpanEntry = {
  id: string
  dbId?: number
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind?: number
  startTime: number
  endTime?: number
  statusCode?: number
  statusMessage?: string
  attributes: Record<string, string>
  events: SpanEvent[]
  resource: Record<string, string>
  scope: { name?: string; version?: string }
}

type TraceSummary = {
  traceId: string
  rootName: string
  startTime: number
  endTime: number
  durationMs: number
  spanCount: number
  errorCount: number
}

type SpanLog = {
  id: string
  spanId: string
  time: number
  body: string
  attributes: Record<string, string>
}

const spans = ref<SpanEntry[]>([])
const selectedTraceId = ref<string | null>(null)
const selectedSpanId = ref<string | null>(null)
const connected = ref(false)
const loading = ref(false)

const filters = reactive({ traceId: '', name: '' })

const pool = useLiveClientPool()
const error = ref('')
const detailError = ref('')
const detailsLoading = ref(false)
const windowFull = ref(false)
const traceLimited = ref(false)
const LIVE_LIMIT = 1000
const retainedTrace = ref<SpanEntry[]>([])
const traceLogs = ref<SpanLog[]>([])
let refreshSpans = () => {}
let refreshDetails = () => {}
let receiveTraceSpan = (_span: SpanEntry) => {}

const traceSummaries = computed<TraceSummary[]>(() => {
  const byTrace = new Map<string, TraceSummary>()
  const nameFilter = filters.name.trim().toLowerCase()
  const traceFilter = filters.traceId.trim().toLowerCase()

  for (const span of spans.value) {
    if (traceFilter && !span.traceId.toLowerCase().includes(traceFilter)) continue
    if (nameFilter && !span.name.toLowerCase().includes(nameFilter)) continue

    const start = span.startTime
    const end = span.endTime ?? span.startTime
    const existing = byTrace.get(span.traceId)
    if (!existing) {
      byTrace.set(span.traceId, {
        traceId: span.traceId,
        rootName: span.parentSpanId ? '' : span.name,
        startTime: start,
        endTime: end,
        durationMs: Math.max(1, end - start),
        spanCount: 1,
        errorCount: span.statusCode === 2 ? 1 : 0,
      })
    } else {
      existing.startTime = Math.min(existing.startTime, start)
      existing.endTime = Math.max(existing.endTime, end)
      existing.durationMs = Math.max(1, existing.endTime - existing.startTime)
      existing.spanCount += 1
      if (!existing.rootName && !span.parentSpanId) existing.rootName = span.name
      if (span.statusCode === 2) existing.errorCount += 1
    }
  }

  return Array.from(byTrace.values()).sort((a, b) => b.startTime - a.startTime)
})

const selectedTraceSpans = computed(() => {
  if (!selectedTraceId.value) return []
  return retainedTrace.value
})

const orderedSpans = computed(() => buildOrderedSpans(selectedTraceSpans.value))

const selectedSpan = computed(() => {
  if (!selectedSpanId.value) return null
  return selectedTraceSpans.value.find((span) => span.spanId === selectedSpanId.value) ?? null
})

const spanLogs = computed(() => traceLogs.value.filter(log => log.spanId === selectedSpanId.value))

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateFields(entry: Record<string, unknown>, fields: string[]) {
  for (const key of fields) {
    const raw = entry[key]
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed == null) continue
    if (key === 'attributes' || key === 'events') {
      if (!Array.isArray(parsed) || !parsed.every(item => record(item)
        && (key !== 'attributes' || typeof item.key === 'string'))) throw new Error(`Invalid ${key}.`)
      if (key === 'events') for (const event of parsed) validateFields(event, ['attributes'])
    } else if (!record(parsed)) throw new Error(`Invalid ${key}.`)
  }
}

function validatedSpan(value: unknown): SpanEntry {
  if (!record(value) || typeof value.trace_id !== 'string' || !value.trace_id
    || typeof value.span_id !== 'string' || !value.span_id || typeof value.name !== 'string'
    || typeof value.start_time !== 'number' || !Number.isFinite(value.start_time)
    || (value.end_time != null && (typeof value.end_time !== 'number' || !Number.isFinite(value.end_time)))) {
    throw new Error('Invalid span record received.')
  }
  validateFields(value, ['attributes', 'events', 'resource', 'scope'])
  return apiSpanToEntry(value)
}

function mergeSpans(entries: SpanEntry[]): SpanEntry[] {
  return [...new Map(entries.map(entry => [entry.id, entry])).values()]
    .sort((a, b) => b.startTime - a.startTime)
}

async function query(base: string, path: string, params: Record<string, string>, signal: AbortSignal) {
  const url = apiUrl(base, path)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Telemetry query failed (${response.status}).`)
  const data: unknown = await response.json()
  if (!record(data) || !Array.isArray(data.entries)) throw new Error('Invalid telemetry query response.')
  return data.entries as unknown[]
}

watch(() => props.apiBase, (base, _previous, onCleanup) => {
  let buffering = true
  const pending = new Map<string, SpanEntry>()
  spans.value = []
  selectedTraceId.value = null
  selectedSpanId.value = null
  retainedTrace.value = []
  traceLogs.value = []
  error.value = ''
  windowFull.value = false
  loading.value = true
  connected.value = false
  const snapshot = createLiveRefresh({
    load: async signal => {
      buffering = true
      loading.value = true
      return (await query(base, '/v1/query/spans', { limit: '300' }, signal)).map(validatedSpan)
    },
    apply: entries => {
      const merged = mergeSpans([...entries, ...pending.values()])
      spans.value = merged.slice(0, LIVE_LIMIT)
      windowFull.value = merged.length >= LIVE_LIMIT
      pending.clear()
      buffering = false
      loading.value = false
      error.value = ''
    },
    onError: () => {
      loading.value = false
      error.value = 'Could not load saved spans. Check Main and retry.'
    },
  })
  refreshSpans = () => {
    pending.clear()
    buffering = true
    loading.value = true
    snapshot.refresh()
  }
  const subscription = pool.client(base).subscribe({
    kind: 'spans', projectId: liveProjectId(base),
  }, {
    event: envelope => {
      try {
        const entry = validatedSpan(envelope.payload)
        if (buffering) {
          pending.set(entry.id, entry)
          if (pending.size > LIVE_LIMIT) pending.delete(pending.keys().next().value!)
        } else {
          const merged = mergeSpans([...spans.value, entry])
          windowFull.value = merged.length >= LIVE_LIMIT
          spans.value = merged.slice(0, LIVE_LIMIT)
        }
        if (entry.traceId === selectedTraceId.value) receiveTraceSpan(entry)
      } catch {
        error.value = 'Could not read a live span. Retry spans to reload saved state.'
      }
    },
    reset: () => { refreshSpans(); refreshDetails() },
  })
  const observe = pool.observe(statuses => {
    connected.value = statuses.length > 0 && statuses.every(status => status.phase === 'live')
  })
  snapshot.refresh()
  onCleanup(() => {
    subscription.close()
    snapshot.dispose()
    observe()
    pending.clear()
  })
}, { immediate: true })

watch([() => props.apiBase, selectedTraceId], ([base, traceId], _previous, onCleanup) => {
  detailError.value = ''
  detailsLoading.value = false
  traceLimited.value = false
  traceLogs.value = []
  retainedTrace.value = spans.value.filter(span => span.traceId === traceId)
  refreshDetails = () => {}
  receiveTraceSpan = () => {}
  if (!traceId) return
  let buffering = true
  const pending = new Map<string, SpanEntry>()
  const details = createLiveRefresh({
    load: async signal => {
      buffering = true
      detailsLoading.value = true
      const controller = new AbortController()
      const requestSignal = AbortSignal.any([signal, controller.signal])
      try {
        const [entries, logs] = await Promise.all([
          query(base, '/v1/query/spans', { traceId, limit: String(LIVE_LIMIT) }, requestSignal),
          query(base, '/v1/query/logs', { traceId, limit: '300' }, requestSignal),
        ])
        return {
          entries: entries.map(value => {
            const entry = validatedSpan(value)
            if (entry.traceId !== traceId) throw new Error('Unexpected trace in query response.')
            return entry
          }),
          logs: logs.map(value => {
            if (!record(value) || typeof value.span_id !== 'string' || typeof value.time !== 'number'
              || !Number.isFinite(value.time) || !('body' in value)) throw new Error('Invalid trace log.')
            validateFields(value, ['attributes'])
            return apiLogToSpanLog(value)
          }).filter((log): log is SpanLog => log !== null),
        }
      } catch (error) {
        controller.abort()
        throw error
      }
    },
    apply: data => {
      const merged = mergeSpans([...data.entries, ...pending.values()])
      retainedTrace.value = merged.slice(0, LIVE_LIMIT)
      traceLimited.value = merged.length >= LIVE_LIMIT
      traceLogs.value = data.logs
      pending.clear()
      buffering = false
      detailsLoading.value = false
      detailError.value = ''
      if (!retainedTrace.value.some(span => span.spanId === selectedSpanId.value)) {
        selectedSpanId.value = orderedSpans.value[0]?.spanId ?? null
      }
    },
    onError: () => {
      detailsLoading.value = false
      detailError.value = 'Could not load this trace and its logs. Check Main and retry.'
    },
  })
  refreshDetails = () => {
    pending.clear()
    buffering = true
    detailsLoading.value = true
    details.refresh()
  }
  receiveTraceSpan = span => {
    if (buffering) {
      pending.set(span.id, span)
      if (pending.size > LIVE_LIMIT) pending.delete(pending.keys().next().value!)
    }
    const merged = mergeSpans([...retainedTrace.value, span])
    retainedTrace.value = merged.slice(0, LIVE_LIMIT)
    const selected = merged.find(entry => entry.spanId === selectedSpanId.value)
    if (selected && !retainedTrace.value.some(entry => entry.id === selected.id)) {
      retainedTrace.value[LIVE_LIMIT - 1] = selected
    }
    traceLimited.value = merged.length >= LIVE_LIMIT
  }
  refreshDetails()
  onCleanup(() => { details.dispose(); pending.clear() })
}, { immediate: true })

function selectTrace(traceId: string): void {
  selectedTraceId.value = traceId
  retainedTrace.value = spans.value.filter(span => span.traceId === traceId)
  const firstSpan = orderedSpans.value[0]
  selectedSpanId.value = firstSpan?.spanId ?? null
}

function selectSpan(spanId: string): void {
  selectedSpanId.value = spanId
}

function buildOrderedSpans(spansForTrace: SpanEntry[]): Array<SpanEntry & { depth: number; durationMs: number } > {
  if (!spansForTrace.length) return []
  const byId = new Map<string, SpanEntry>()
  const children = new Map<string, SpanEntry[]>()
  for (const span of spansForTrace) {
    byId.set(span.spanId, span)
    const parent = span.parentSpanId ?? 'root'
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)?.push(span)
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.startTime - b.startTime)
  }

  const roots = spansForTrace.filter(span => !span.parentSpanId || !byId.has(span.parentSpanId))
    .sort((a, b) => a.startTime - b.startTime)
  const ordered: Array<SpanEntry & { depth: number; durationMs: number } > = []
  const visited = new Set<string>()

  const walk = (node: SpanEntry, depth: number) => {
    if (visited.has(node.spanId)) return
    visited.add(node.spanId)
    const durationMs = Math.max(1, (node.endTime ?? node.startTime) - node.startTime)
    ordered.push({ ...node, depth, durationMs })
    const kids = children.get(node.spanId) ?? []
    for (const child of kids) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  for (const span of spansForTrace) if (!visited.has(span.spanId)) walk(span, 0)
  return ordered
}

const DEPTH_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#6366f1', // indigo
]

function depthColor(depth: number): string {
  return DEPTH_COLORS[depth % DEPTH_COLORS.length]
}

const timelineTicks = computed(() => {
  const traceSpans = selectedTraceSpans.value
  if (!traceSpans.length) return []
  const minStart = Math.min(...traceSpans.map((s) => s.startTime))
  const maxEndBase = Math.max(...traceSpans.map((s) => s.endTime ?? s.startTime))
  const hasOpen = traceSpans.some((s) => !s.endTime)
  const maxEnd = hasOpen ? Math.max(maxEndBase, Date.now()) : maxEndBase
  const range = Math.max(1, maxEnd - minStart)
  const count = 5
  const ticks: { pct: number; label: string }[] = []
  for (let i = 0; i <= count; i++) {
    const pct = (i / count) * 100
    const ms = (i / count) * range
    ticks.push({ pct, label: formatDuration(ms) })
  }
  return ticks
})

function barStyle(span: { startTime: number; endTime?: number }): Record<string, string> {
  const spansForTrace = selectedTraceSpans.value
  if (!spansForTrace.length) return { width: '100%' }
  const minStart = Math.min(...spansForTrace.map((s) => s.startTime))
  const maxEndBase = Math.max(...spansForTrace.map((s) => s.endTime ?? s.startTime))
  const hasOpen = spansForTrace.some((s) => !s.endTime)
  const maxEnd = hasOpen ? Math.max(maxEndBase, Date.now()) : maxEndBase
  const range = Math.max(1, maxEnd - minStart)
  const startOffset = span.startTime - minStart
  const end = (span.endTime ?? span.startTime) - minStart
  const width = Math.max(4, ((end - startOffset) / range) * 100)
  const left = (startOffset / range) * 100
  return { left: `${left}%`, width: `${width}%` }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.round((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

function spanDurationMs(span: SpanEntry): number {
  return Math.max(1, (span.endTime ?? span.startTime) - span.startTime)
}

function apiLogToSpanLog(entry: Record<string, unknown>): SpanLog | null {
  const spanId = typeof entry.span_id === 'string' ? entry.span_id : ''
  if (!spanId) return null
  const time = typeof entry.time === 'number' ? entry.time : Date.now()
  const bodyVal = unwrapAnyValue(entry.body)
  const body = typeof bodyVal === 'string' ? bodyVal.replace(/\n$/, '') : (bodyVal != null ? JSON.stringify(bodyVal) : 'log')
  const attributes = parseOtelAttributes(entry.attributes)
  return {
    id: `${spanId}:${String(entry.id ?? spanId)}`,
    spanId,
    time,
    body,
    attributes,
  }
}

function apiSpanToEntry(entry: Record<string, unknown>): SpanEntry {
  const id = `${entry.trace_id}:${entry.span_id}`
  const dbId = typeof entry.id === 'number' ? entry.id : undefined
  const traceId = String(entry.trace_id ?? '')
  const spanId = String(entry.span_id ?? '')
  const parentSpanId = entry.parent_span_id ? String(entry.parent_span_id) : undefined
  const name = String(entry.name ?? 'span')
  const startTime = typeof entry.start_time === 'number' ? entry.start_time : Date.now()
  const endTime = typeof entry.end_time === 'number' ? entry.end_time : undefined
  const statusCode = typeof entry.status_code === 'number' ? entry.status_code : undefined
  const statusMessage = typeof entry.status_message === 'string' ? entry.status_message : undefined
  const attributes = parseOtelAttributes(entry.attributes)
  const events = parseSpanEvents(entry.events, startTime)
  const resource = parseResource(entry.resource)
  const scope = parseScope(entry.scope)

  return {
    id,
    dbId,
    traceId,
    spanId,
    parentSpanId,
    name,
    startTime,
    endTime,
    statusCode,
    statusMessage,
    attributes,
    events,
    resource,
    scope,
  }
}

function parseSpanEvents(raw: unknown, traceStart: number): SpanEvent[] {
  let events: unknown[] = []
  if (typeof raw === 'string') {
    try { events = JSON.parse(raw) } catch { /* ignore */ }
  } else if (Array.isArray(raw)) {
    events = raw
  }

  return events.map((evt, index) => {
    const item = evt as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name : 'event'
    const timeUnix = item.timeUnixNano ?? item.time_unix_nano ?? item.time
    const timeMs = nanoToMs(timeUnix as string | number | undefined)
    const attributes = parseOtelAttributes(item.attributes)
    const exception = extractException(attributes)
    return {
      id: `${name}-${index}`,
      name,
      timeMs,
      offsetMs: Math.max(0, timeMs - traceStart),
      attributes,
      isException: Boolean(exception),
      exception: exception ?? undefined,
    }
  }).sort((a, b) => a.timeMs - b.timeMs)
}

function extractException(attrs: Record<string, string>): { type: string; message: string; stacktrace?: string } | null {
  const type = attrs['exception.type'] ?? ''
  const message = attrs['exception.message'] ?? ''
  const stacktrace = attrs['exception.stacktrace']
  if (!type && !message) return null
  return { type: type || 'Exception', message: message || 'Unknown error', stacktrace }
}

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

function parseResource(raw: unknown): Record<string, string> {
  if (!raw) return {}
  try {
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw
    const attrs = (res as Record<string, unknown>)?.attributes
    return parseOtelAttributes(attrs)
  } catch {
    return {}
  }
}

function parseScope(raw: unknown): { name?: string; version?: string } {
  if (!raw) return {}
  try {
    const scope = typeof raw === 'string' ? JSON.parse(raw) : raw
    const data = scope as Record<string, unknown>
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      version: typeof data.version === 'string' ? data.version : undefined,
    }
  } catch {
    return {}
  }
}

function unwrapAnyValue(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'string') {
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

function nanoToMs(v?: string | number): number {
  if (v === undefined || v === null) return Date.now()
  try {
    const n = typeof v === 'string' ? BigInt(v) : BigInt(v)
    return Number(n / 1_000_000n)
  } catch {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : Date.now()
  }
}

</script>

<style scoped>
.input {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  background: var(--c-bg-card);
}

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
  border-color: var(--c-primary-bg);
}

.tag.small {
  font-size: 0.6rem;
  padding: 0.05rem 0.3rem;
}

.trace-list {
  display: grid;
  gap: 0.35rem;
  max-height: 520px;
  overflow: auto;
  padding-right: 0.2rem;
}

.trace-item {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  padding: 0.45rem 0.6rem;
  background: var(--c-bg-card);
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
  text-align: left;
  transition: background 0.1s ease;
}

.trace-item:hover {
  background: var(--c-bg-soft);
}

.trace-item.active {
  border-color: var(--c-primary-bg);
  background: var(--c-bg-muted);
}

.trace-main {
  min-width: 0;
  display: grid;
  gap: 0.15rem;
}

.trace-title {
  font-weight: 600;
  font-size: 0.8rem;
}

.trace-meta {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
}

.trace-error {
  color: var(--c-error);
  font-weight: 600;
}

.trace-side {
  display: grid;
  gap: 0.15rem;
  text-align: right;
  font-size: 0.65rem;
  color: var(--c-text-muted);
}

.trace-id {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.timeline {
  margin-top: 0.75rem;
  display: grid;
  gap: 0.5rem;
}

.timeline-header {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
}

.timeline-ruler {
  position: relative;
  height: 20px;
  border-bottom: 1px solid var(--c-border);
}

.ruler-tick {
  position: absolute;
  bottom: 2px;
  transform: translateX(-50%);
  font-size: 0.55rem;
  color: var(--c-text-muted);
  white-space: nowrap;
}

.ruler-tick::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 50%;
  width: 1px;
  height: 5px;
  background: var(--c-border);
}

.timeline-rows {
  display: grid;
}

.timeline-row {
  border: 1px solid var(--c-border);
  padding: 0.25rem 0.4rem;
  background: var(--c-bg-card);
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  align-items: center;
  gap: 0.3rem;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
  animation: row-enter 0.25s ease both;
  animation-delay: var(--row-delay, 0ms);
}

.timeline-row:hover {
  background: var(--c-bg-soft);
  border-color: var(--c-border-hover);
  box-shadow: 0 1px 4px var(--c-shadow-soft);
}

.timeline-row.active {
  border-color: var(--c-primary-bg);
  background: var(--c-bg-muted);
  box-shadow: 0 0 0 1px var(--c-primary-bg), 0 2px 8px var(--c-shadow-soft);
}

.timeline-row.error {
  background: var(--c-error-bg);
}

.timeline-row.open {
  border-style: dashed;
}

@keyframes row-enter {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.timeline-label {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.tree-connector {
  position: absolute;
  top: -50%;
  width: 12px;
  height: 100%;
  pointer-events: none;
}

.tree-connector::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 50%;
  background: var(--c-border-soft);
}

.tree-connector::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 10px;
  height: 1px;
  background: var(--c-border-soft);
}

.depth-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-circle);
  box-shadow: 0 0 4px color-mix(in srgb, currentColor 40%, transparent);
}

.span-name {
  font-weight: 600;
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.span-error {
  font-size: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.05rem 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--c-error);
  color: white;
}

.span-live {
  font-size: 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.05rem 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--c-success);
  color: white;
  animation: pulse-live 1.5s ease-in-out infinite;
}

@keyframes pulse-live {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.timeline-bar {
  position: relative;
  height: 20px;
  background: var(--c-bg-muted);
  border-radius: var(--radius-control);
  overflow: hidden;
}

.bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--bar-color, var(--c-gradient-start)), color-mix(in srgb, var(--bar-color, var(--c-gradient-end)) 70%, white));
  display: flex;
  align-items: center;
  padding-left: 0.3rem;
  color: white;
  font-size: 0.55rem;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
  transition: filter 0.15s ease;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--bar-color, var(--c-gradient-start)) 30%, transparent);
}

.timeline-row:hover .bar {
  filter: brightness(1.15);
}

.bar-open {
  animation: bar-pulse 2s ease-in-out infinite;
  background-image: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 4px,
    rgba(255,255,255,0.12) 4px,
    rgba(255,255,255,0.12) 8px
  ), linear-gradient(90deg, var(--bar-color, var(--c-gradient-start)), color-mix(in srgb, var(--bar-color, var(--c-gradient-end)) 70%, white));
}

@keyframes bar-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.75; }
}

.bar-label {
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
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

.event-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.45rem 0.55rem;
  display: grid;
  gap: 0.3rem;
  background: var(--c-bg-soft);
}

.event-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  color: var(--c-text-secondary);
}

.event-name {
  font-weight: 600;
}

.event-time {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.event-tag {
  font-size: 0.55rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.05rem 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--c-error-bg);
  color: var(--c-error);
}

.event-exception {
  font-size: 0.7rem;
  display: grid;
  gap: 0.25rem;
}

.exception-line {
  font-weight: 600;
}

.exception-trace {
  margin: 0;
  font-size: 0.65rem;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--c-bg-muted);
  padding: 0.4rem;
  border-radius: var(--radius-control);
}

.event-attrs {
  display: grid;
  gap: 0.25rem;
}
</style>
