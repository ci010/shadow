<template>
  <section class="session-diagnosis" :aria-label="t('Session diagnosis')">
    <div class="diagnosis-navigation">
      <div class="diagnosis-views" role="tablist" :aria-label="t('Diagnosis view')">
        <button v-for="view in views" :id="domId(`diagnosis-${view.id}-tab`)" :key="view.id" role="tab"
          :aria-selected="section === view.id" :aria-controls="domId(`diagnosis-${view.id}`)"
          :tabindex="section === view.id ? 0 : -1" :class="{ selected: section === view.id }"
          @click="section = view.id" @keydown="navigateViews($event, view.id)">
          {{ view.label }}<span v-if="view.id === 'tools'" class="view-count">{{ tools.length }}</span>
        </button>
      </div>
      <span v-if="section !== 'stats'" class="diagnosis-status" :class="{ working: working && !physicalId && !error }">
        <i v-if="working && !physicalId && !error" aria-hidden="true" />
        {{ error ? t('Update unavailable') : physicalId ? t('Historical segment') : working ? t('Recording') : t('Auto-refresh') }}
      </span>
    </div>

    <div v-show="section === 'trace'" :id="domId('diagnosis-trace')" class="diagnosis-scroll" role="tabpanel" :aria-labelledby="domId('diagnosis-trace-tab')" tabindex="0">
      <div v-if="!canReadTrace" class="diagnosis-empty">{{ t('Session traces require audit:read access. System prompt and tools are available in the tabs above.') }}</div>
      <template v-else>
        <div class="trace-heading">
          <div><h2>{{ t('Session trace') }}</h2><p>{{ physicalId ? t('History and execution for this physical segment.') : t('History and execution for the current segment.') }}</p></div>
          <button class="diagnosis-button" :disabled="exporting" @click="exportDiagnosis">{{ exporting ? t('Exporting...') : t('Export for agent') }}</button>
          <button class="diagnosis-button" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing...') : t('Refresh') }}</button>
        </div>
        <p class="timeline-note">{{ t('Agent exports contain bounded, best-effort-redacted evidence for this segment. Review before sharing.') }}</p>
        <p v-if="exportStatus" class="timeline-note" role="status">{{ exportStatus }}</p>
        <div v-if="exportError" class="diagnosis-error" role="alert">{{ exportError }}</div>
        <div v-if="error" class="diagnosis-error" role="alert">{{ error }}<span v-if="events.length || spans.length"> {{ t('Showing the last successful snapshot.') }}</span></div>
        <div class="trace-metrics">
          <div :title="t('Union of loaded execution spans, excluding gaps between turns. Not the age of the conversation.')"><strong>{{ formatTraceDuration(duration) }}</strong><span>{{ t('Duration') }} <small v-if="hasMore">{{ t('(loaded spans)') }}</small></span></div>
          <div><strong>{{ turns }}</strong><span>{{ t('User turns') }}</span></div>
          <div><strong>{{ modelSpans.length }}</strong><span>{{ t('Model calls') }} <small v-if="hasMore">{{ t('(loaded)') }}</small></span></div>
          <div :title="hasUnlinkedToolSpans ? t('Legacy spans have no call ID, so this is a lower bound rather than a guessed pairing.') : t('Recorded tool calls')"><strong><template v-if="hasUnlinkedToolSpans">&ge; </template>{{ toolCallCount }}</strong><span>{{ t('Tool calls') }}<small v-if="hasUnlinkedToolSpans"> {{ t('(legacy IDs missing)') }}</small></span></div>
        </div>
        <div class="trace-search">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="m12 12 5 5"/></svg>
          <input v-model="query" type="search" :aria-label="t('Search session trace')" :placeholder="t('Search messages, tools, arguments and spans...')" />
          <span v-if="query">{{ filteredEvents.length }} {{ t('events') }}</span>
        </div>

        <div class="trace-timeline" :aria-label="t('Execution timeline')">
          <div class="timeline-controls">
            <span>{{ t('Execution overview') }} <small>{{ zoomWindow ? t('Custom window') : t('Latest 5 min') }}</small></span>
            <button class="diagnosis-button" :aria-label="t('Zoom into trace')" :disabled="timelineRange.end - timelineRange.start <= 1" @click="zoomTimeline(.5)">+</button>
            <button class="diagnosis-button" :aria-label="t('Zoom out of trace')" :disabled="!canPanTimeline" @click="zoomTimeline(2)">&minus;</button>
            <button class="diagnosis-button" :disabled="!zoomWindow" @click="zoomWindow = undefined">{{ t('Latest 5 min') }}</button>
          </div>
          <div class="timeline-scale"><span>{{ t('Elapsed') }}</span><div><span>{{ formatTraceDuration(timelineRange.start - fullTimelineRange.start) }}</span><span>{{ formatTraceDuration(timelineRange.end - fullTimelineRange.start) }}</span></div></div>
          <div v-for="lane in visibleLanes" :key="lane.name" class="timeline-lane">
            <span>{{ lane.name }}</span>
            <div class="lane-track" :style="{ height: `${lane.height}px` }">
              <HoverInfo v-for="item in lane.items" :key="item.id">
                <template #default="{ triggerProps, close }">
                  <button v-bind="triggerProps" class="lane-bar"
                    :class="[lane.name.toLowerCase(), { running: item.live, failed: item.failed, dimmed: !item.matches, picked: selectedId === item.id }]"
                    :style="timelineStyle(item)" :aria-label="item.label" :aria-pressed="selectedId === item.id"
                    :aria-controls="selectedId === item.id ? domId('trace-inspector') : undefined"
                    @click="close(); selectedId = item.id" />
                </template>
                <template #content>
                  <strong class="timeline-hover-title">{{ item.title }}</strong>
                  <dl class="timeline-hover-meta">
                    <dt>{{ t('Started') }}</dt><dd>{{ formatTime(item.start) }}</dd>
                    <template v-if="item.span">
                      <dt>{{ t('Duration') }}</dt><dd>{{ formatTraceDuration(spanDuration(item.span, now)) }}{{ item.live ? t(' elapsed') : '' }}</dd>
                      <dt>{{ t('Status') }}</dt><dd>{{ item.live ? t('Running') : item.failed ? t('Error') : t('Completed') }} {{ item.span.statusMessage }}</dd>
                      <dt>{{ t('Trace') }}</dt><dd>{{ item.span.traceId }}</dd><dt>{{ t('Span') }}</dt><dd>{{ item.span.spanId }}</dd>
                      <template v-for="(value, key) in item.span.attributes" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template>
                    </template>
                    <template v-else-if="item.event"><dt>{{ t('Kind') }}</dt><dd>{{ enumLabel(item.event.kind) }}</dd><dt>{{ t('Turn') }}</dt><dd>{{ item.event.turn }}</dd></template>
                  </dl>
                </template>
              </HoverInfo>
            </div>
          </div>
          <div v-if="canPanTimeline" class="timeline-pan">
            <button class="diagnosis-button" :aria-label="t('Previous time window')" :disabled="panPosition <= 0" @click="moveTimeline(-1)">&larr;</button>
            <label>{{ t('Move window') }}<input type="range" min="0" max="100" step="0.1" :aria-label="t('Pan trace timeline')"
              :aria-valuetext="t('{start} to {end}', { start: formatTime(timelineRange.start), end: formatTime(timelineRange.end) })" :value="panPosition" @input="panTimeline" /></label>
            <button class="diagnosis-button" :aria-label="t('Next time window')" :disabled="panPosition >= 100" @click="moveTimeline(1)">&rarr;</button>
          </div>
          <p v-if="hasTimelineItems && !visibleLanes.some(lane => lane.items.length)" class="timeline-note" role="status">{{ t('No recorded activity in this window. Move the window to inspect another time.') }}</p>
          <p class="timeline-note">{{ spans.length ? t('Actual recorded timings; hover for duration, select for details. Gaps include time between requests.') : t('No execution timing is recorded for this segment. Message timestamps are not model or tool durations.') }}</p>
        </div>

        <div v-if="selectedSpan || selectedEvent" :id="domId('trace-inspector')" class="span-inspector" role="region" :aria-label="t('Selected trace item details')">
          <div class="inspector-heading">
            <span class="event-kind" :class="selectedEvent?.kind || (selectedSpan?.name === 'agent.tool' ? 'TOOL' : 'ASSISTANT')">{{ enumLabel(selectedEvent?.kind || (selectedSpan?.name === 'agent.tool' ? 'TOOL' : t('SPAN'))) }}</span>
            <strong>{{ selectedEvent?.title || selectedSpan?.attributes['tool.name'] || selectedSpan?.name }}</strong>
            <span v-if="selectedSpan">{{ formatTraceDuration(spanDuration(selectedSpan, now)) }}{{ selectedSpan.live ? t(' elapsed') : '' }}</span>
            <button class="diagnosis-button" :aria-label="t('Close trace item details')" @click="selectedId = ''">&times;</button>
          </div>
          <dl v-if="selectedSpan" class="span-identity"><dt>{{ t('Trace') }}</dt><dd>{{ selectedSpan.traceId }}</dd><dt>{{ t('Span') }}</dt><dd>{{ selectedSpan.spanId }}</dd><dt>{{ t('Started') }}</dt><dd>{{ formatTime(selectedSpan.startTime) }}</dd><dt>{{ t('Status') }}</dt><dd>{{ selectedSpan.live ? t('Running') : selectedSpan.statusCode === 2 ? t('Error') : t('Completed') }} {{ selectedSpan.statusMessage }}</dd></dl>
          <dl v-else-if="selectedEvent" class="span-identity"><dt>{{ t('Started') }}</dt><dd>{{ formatTime(selectedEvent.timestamp) }}</dd><dt>{{ t('Turn') }}</dt><dd>{{ selectedEvent.turn }}</dd></dl>
          <TraceEventDetails v-if="selectedEvent" :event="selectedEvent" />
          <template v-else-if="selectedModelResponse.detail">
            <h4>{{ t('Model response') }}</h4>
            <p v-if="selectedModelResponse.detail.source === 'history'" class="missing-detail">{{ t('Historical response matched by recorded input message count and completion interval.') }}</p>
            <TraceEventDetails :event="selectedModelResponse.detail.event" />
          </template>
          <p v-else-if="selectedModelResponse.error" class="diagnosis-error" role="alert">{{ selectedModelResponse.error }}</p>
          <p v-else-if="selectedSpan?.name === 'agent.tool'" class="missing-detail">{{ t('No unique matching tool call in this segment\'s history. Arguments and results are unavailable.') }}</p>
          <p v-else-if="selectedSpan?.name === 'agent.chat'" class="missing-detail">{{ selectedSpan.live ? t('Waiting for this model call to return its message.') : selectedSpan.statusCode === 2 ? t('This model call failed before returning a message.') : t('No response was captured for this historical call, and its history cannot be uniquely matched.') }}</p>
          <template v-if="selectedSpan">
            <details open><summary>{{ t('Attributes') }}</summary><pre>{{ detailText(selectedSpan.attributes) }}</pre></details>
            <details v-if="selectedSpan.events.length" :open="!selectedModelResponse.detail"><summary>{{ t('Events & exceptions (') }}{{ selectedSpan.events.length }})</summary><pre>{{ detailText(selectedSpan.events) }}</pre></details>
          </template>
        </div>

        <div class="events-heading"><h3>{{ t('Recorded events') }}</h3><div class="event-fold-controls"><button class="diagnosis-button" @click="toggleAllTurns">{{ allTurnsCollapsed ? t('Expand turns') : t('Collapse turns') }}</button><button class="diagnosis-button" @click="toggleAllCalls">{{ allCallsExpanded ? t('Collapse calls') : t('Expand calls') }}</button></div><span>{{ events.length }} {{ t('events') }}</span></div>
        <div class="event-filters" :aria-label="t('Filter recorded events')">
          <button v-for="kind in kinds" :key="kind" :class="{ selected: filter === kind }" :aria-pressed="filter === kind" @click="filter = kind">{{ kind === 'ALL' ? t('All events') : enumLabel(kind).toLowerCase() }}</button>
        </div>
        <div v-if="loading && !events.length && !spans.length" class="diagnosis-empty" role="status">{{ t('Loading this session\'s trace...') }}</div>
        <div v-else-if="!filteredEvents.length" class="diagnosis-empty">{{ query || filter !== 'ALL' ? t('No events match this filter.') : t('No messages recorded in this segment yet.') }}</div>
        <div v-for="group in eventGroups" :key="group.turn" class="trace-turn">
          <button class="turn-heading" :aria-expanded="!collapsedTurns.has(group.turn) || !!query || filter !== 'ALL'" @click="toggleTurn(group.turn)"><span>{{ collapsedTurns.has(group.turn) && !query && filter === 'ALL' ? '&#9656;' : '&#9662;' }} {{ group.turn ? t('Turn {turn}', { turn: group.turn }) : t('Session context') }}</span><span>{{ group.events.length }} {{ t('events') }}</span></button>
          <div v-show="!collapsedTurns.has(group.turn) || query || filter !== 'ALL'">
          <div v-for="event in group.events" :key="event.id" class="trace-event" :class="[diagnosisBatchColor(event), { expanded: expanded.has(event.id), highlighted: selectedEvent?.id === event.id }]" :data-batch-id="event.batchId">
            <button class="trace-event-header" :title="event.batchId ? batchDescription(event) : undefined" :aria-describedby="event.batchId ? domId(event.id + '-batch') : undefined" :aria-expanded="expanded.has(event.id)" @click="toggleEvent(event.id)">
              <span class="event-chevron" aria-hidden="true">{{ expanded.has(event.id) ? '&#9662;' : '&#9656;' }}</span>
              <span class="event-kind" :class="event.kind">{{ enumLabel(event.kind) }}</span>
              <strong v-if="event.kind === 'TOOL' || event.kind === 'CONTEXT' || event.kind === 'SESSION'" class="event-name">{{ event.title }}</strong>
              <span v-if="event.sessionSource" class="event-origin" :title="event.sessionSource.id">{{ event.sessionSource.id || event.sessionSource.name || t('Unknown session') }}</span>
              <span v-if="event.batchId" class="event-batch-indicator" aria-hidden="true" />
              <span class="event-preview">{{ preview(event) }}</span>
              <span v-if="event.kind === 'TOOL' && toolSpan(event.id)" class="event-duration">{{ formatTraceDuration(spanDuration(toolSpan(event.id)!, now)) }}</span>
              <time class="event-time" :title="formatTime(event.timestamp)">{{ shortTime(event.timestamp) }}</time>
            </button>
            <span v-if="event.batchId" :id="domId(event.id + '-batch')" class="batch-description">{{ batchDescription(event) }}</span>
            <div v-if="expanded.has(event.id) && (!collapsedTurns.has(group.turn) || query || filter !== 'ALL')" class="trace-event-detail">
              <div v-if="event.callId" class="event-call-id">{{ t('Call ID:') }} {{ event.callId }}<button v-if="toolSpan(event.id)" class="diagnosis-button" @click="selectSpan(toolSpan(event.id)!)">{{ t('Inspect timing') }}</button></div>
              <TraceEventDetails :event="event" />
            </div>
            </div>
          </div>
        </div>
        <details class="all-spans">
          <summary>{{ t('All execution spans') }} <span>{{ filteredSpans.length }}{{ query ? t(' matching') : '' }}</span></summary>
          <p class="timeline-note">{{ t('Includes model, tool, context and nested execution spans where recorded. Selecting a span shows its attributes and errors.') }}</p>
          <button v-for="span in filteredSpans" :key="traceKey(span)" class="span-row" :class="{ failed: span.statusCode === 2 }" @click="selectSpan(span)">
            <span class="span-dot" :class="{ running: span.live }" /><strong>{{ span.name }}</strong><span>{{ span.attributes['tool.name'] || span.attributes.model || '' }}</span><span>{{ formatTraceDuration(spanDuration(span, now)) }}</span>
          </button>
          <div v-if="!filteredSpans.length" class="diagnosis-empty">{{ t('No recorded spans match.') }}</div>
        </details>
        <button v-if="hasMore" class="diagnosis-button load-earlier" :disabled="loading" @click="loadEarlier">{{ t('Load earlier execution spans') }}</button>
        <p class="trace-footnote">{{ t('History comes from this segment\'s persisted messages. Tool results are paired by call ID. Missing timing or historical context is never estimated.') }}</p>
      </template>
    </div>

    <div v-show="section === 'prompt'" :id="domId('diagnosis-prompt')" class="diagnosis-scroll context-view" role="tabpanel" :aria-labelledby="domId('diagnosis-prompt-tab')" tabindex="0">
      <p class="context-note">{{ t('Current session system prompt, not a captured prompt for each historical model call.') }}</p>
      <SystemPromptCard :prompt="systemPrompt" empty-message="No system prompt loaded for this session." />
      <SystemPromptCard v-if="compactionSummary" :title="t('Compaction Summary')" :prompt="compactionSummary" :show-token-estimate="true" />
    </div>
    <div v-show="section === 'tools'" :id="domId('diagnosis-tools')" class="diagnosis-scroll context-view" role="tabpanel" :aria-labelledby="domId('diagnosis-tools-tab')" tabindex="0">
      <p class="context-note">{{ t('Currently available tool definitions. Actual calls, arguments and results are in Trace.') }}</p>
      <ToolsCard :tools="tools" />
    </div>
    <div v-show="section === 'stats'" :id="domId('diagnosis-stats')" class="diagnosis-scroll context-view" role="tabpanel" :aria-labelledby="domId('diagnosis-stats-tab')" tabindex="0">
      <SessionProfile :api-base="apiBase" :session-id="sessionId" :active="active && section === 'stats'" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
import { enumLabel } from '../display-labels.ts'
import { apiUrl } from '../api-url.ts'
import { fetchDiagnosisExport } from '../diagnosis-export.ts'
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import HoverInfo from './HoverInfo.vue'
import TraceEventDetails from './TraceEventDetails.vue'
import SystemPromptCard from './SystemPromptCard.vue'
import SessionProfile from './SessionProfile.vue'
import ToolsCard, { type ToolDef } from './ToolsCard.vue'
import type { DiagnosisSection } from '../composables/useDiagnosisNavigation.ts'
import {
  correlateModelSpans, correlateToolSpans, detailText, diagnosisBatchColor, eventMatches, fetchDiagnosisJson, fitTraceWindow, formatTraceDuration, latestTraceWindow, mergeTraceSpans, parseDiagnosisHistory, recordedModelResponse,
  parseTracePage, spanDuration, spanMatches, stackTimelineItems, traceDuration, traceKey,
  type DiagnosisEvent, type ModelResponseDetail, type SessionTraceSpan, type TracePage, type TraceWindow,
} from '../session-diagnosis.ts'

const props = defineProps<{
  apiBase: string
  sessionId: string
  physicalId: string | null
  active: boolean
  canReadTrace: boolean
  working: boolean
  systemPrompt: string
  compactionSummary: string
  tools: ToolDef[]
  idPrefix?: string
}>()
const domId = (id: string) => props.idPrefix ? `${props.idPrefix}-${id}` : id
const views = [{ id: 'trace', get label() { return t('Trace') } }, { id: 'prompt', get label() { return t('System prompt') } }, { id: 'tools', get label() { return t('Tools') } }, { id: 'stats', get label() { return t('Statistics') } }] as const
const section = defineModel<DiagnosisSection>('section', { default: 'trace' })
const query = ref('')
const kinds = ['ALL', 'USER', 'SESSION', 'ASSISTANT', 'TOOL', 'CONTEXT', 'SYSTEM']
const filter = ref('ALL')
const events = ref<DiagnosisEvent[]>([])
const modelResponses = ref<DiagnosisEvent[]>([])
const spans = ref<SessionTraceSpan[]>([])
const loading = ref(false)
const error = ref('')
const exporting = ref(false)
const exportError = ref('')
const exportStatus = ref('')
let exportRequest: AbortController | undefined
const now = ref(Date.now())
const selectedId = ref('')
const expanded = reactive(new Set<string>())
const collapsedTurns = reactive(new Set<number>())
const zoomWindow = ref<TraceWindow>()
let currentPhysicalId: string | undefined
let beforeId: number | undefined
const hasMore = ref(false)
let request: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let loaded = false

const duration = computed(() => traceDuration(spans.value.filter(span => ['session.processMessage', 'agent.loop', 'agent.chat', 'agent.tool'].includes(span.name)), now.value))
const turns = computed(() => events.value.reduce((max, event) => Math.max(max, event.turn), 0))
const modelSpans = computed(() => spans.value.filter(span => span.name === 'agent.chat'))
const toolSpans = computed(() => spans.value.filter(span => span.name === 'agent.tool'))
const hasUnlinkedToolSpans = computed(() => toolSpans.value.some(span => !span.attributes['tool.call_id']))
const toolCallCount = computed(() => {
  const historyCounts = new Map<string, number>()
  const spanCounts = new Map<string, number>()
  let orphanCount = 0
  for (const event of events.value.filter(event => event.kind === 'TOOL')) {
    if (event.callId) historyCounts.set(event.callId, (historyCounts.get(event.callId) ?? 0) + 1)
    else orphanCount++
  }
  for (const span of toolSpans.value) {
    const callId = span.attributes['tool.call_id']
    // Legacy spans without call IDs cannot safely be deduplicated against history.
    if (callId) spanCounts.set(callId, (spanCounts.get(callId) ?? 0) + 1)
  }
  const knownCount = orphanCount + [...new Set([...historyCounts.keys(), ...spanCounts.keys()])]
    .reduce((sum, id) => sum + Math.max(historyCounts.get(id) ?? 0, spanCounts.get(id) ?? 0), 0)
  return Math.max(knownCount, toolSpans.value.length)
})
const filteredEvents = computed(() => events.value.filter(event => eventMatches(event, query.value, filter.value)))
const filteredSpans = computed(() => spans.value.filter(span => spanMatches(span, query.value)))
const eventGroups = computed(() => {
  const groups = new Map<number, DiagnosisEvent[]>()
  for (const event of filteredEvents.value) {
    const group = groups.get(event.turn) ?? []
    group.push(event)
    groups.set(event.turn, group)
  }
  return [...groups].map(([turn, events]) => ({ turn, events }))
})
const allTurnsCollapsed = computed(() => eventGroups.value.length > 0 && eventGroups.value.every(group => collapsedTurns.has(group.turn)))
const allCallsExpanded = computed(() => {
  const calls = events.value.filter(event => event.kind === 'TOOL')
  return calls.length > 0 && calls.every(event => expanded.has(event.id))
})
function toggleTurn(turn: number): void {
  if (collapsedTurns.has(turn)) collapsedTurns.delete(turn)
  else collapsedTurns.add(turn)
}
function toggleAllTurns(): void {
  if (allTurnsCollapsed.value) collapsedTurns.clear()
  else for (const group of eventGroups.value) collapsedTurns.add(group.turn)
}
function toggleAllCalls(): void {
  const collapse = allCallsExpanded.value
  for (const event of events.value.filter(event => event.kind === 'TOOL')) {
    if (collapse) expanded.delete(event.id)
    else expanded.add(event.id)
  }
}
const selectedSpan = computed(() => spans.value.find(span => traceKey(span) === selectedId.value))
const historicalModelResponses = computed(() => correlateModelSpans(modelResponses.value, modelSpans.value))
const selectedModelResponse = computed<{ detail?: ModelResponseDetail; error?: string }>(() => {
  if (selectedSpan.value?.name !== 'agent.chat') return {}
  try {
    return { detail: recordedModelResponse(selectedSpan.value) ?? historicalModelResponses.value.get(selectedId.value) }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
})
const selectedEvent = computed(() => {
  return events.value.find(event => event.id === selectedId.value) ?? (selectedSpan.value ? events.value.find(event => {
    const span = toolSpan(event.id)
    return span && traceKey(span) === selectedId.value
  }) : undefined)
})
const toolSpanById = computed(() => correlateToolSpans(events.value, toolSpans.value))
function toolSpan(eventId: string): SessionTraceSpan | undefined {
  return toolSpanById.value.get(eventId)
}

interface TimelineItem { id: string; start: number; end: number; title: string; label: string; live: boolean; failed: boolean; matches: boolean; span?: SessionTraceSpan; event?: DiagnosisEvent }
const lanes = computed<Array<{ name: string; items: TimelineItem[] }>>(() => {
  const spanItems = (items: SessionTraceSpan[]): TimelineItem[] => items.map(span => ({
    id: traceKey(span), start: span.startTime,
    end: span.live ? Math.max(now.value, span.startTime) : span.endTime ?? span.startTime,
    title: span.attributes['tool.name'] || span.name, span,
    label: `${span.attributes['tool.name'] || span.name} | ${formatTime(span.startTime)} | ${formatTraceDuration(spanDuration(span, now.value))}${span.live ? ' elapsed (running)' : ''}`,
    live: span.live, failed: span.statusCode === 2, matches: spanMatches(span, query.value),
  }))
  return [
    { name: 'Input', items: events.value.flatMap(event => event.timestamp !== undefined && ['USER', 'SESSION', 'CONTEXT', 'SYSTEM'].includes(event.kind)
      ? [{ id: event.id, start: event.timestamp, end: event.timestamp, title: event.title, event, label: `${event.kind} | ${formatTime(event.timestamp)} | ${preview(event)}`, live: false, failed: false, matches: eventMatches(event, query.value) }] : []) },
    { name: 'Model', items: spanItems(modelSpans.value) },
    { name: 'Tools', items: spanItems(toolSpans.value) },
  ]
})
const fullTimelineRange = computed(() => {
  const items = lanes.value.flatMap(lane => lane.items)
  if (!items.length) return { start: 0, end: 0 }
  return { start: Math.min(...items.map(item => item.start)), end: Math.max(...items.map(item => item.end)) }
})
const hasTimelineItems = computed(() => lanes.value.some(lane => lane.items.length))
const timelineRange = computed(() => zoomWindow.value ? fitTraceWindow(zoomWindow.value, fullTimelineRange.value) : latestTraceWindow(fullTimelineRange.value))
const canPanTimeline = computed(() => timelineRange.value.end - timelineRange.value.start < fullTimelineRange.value.end - fullTimelineRange.value.start)
const visibleLanes = computed(() => lanes.value.map(lane => {
  const items = stackTimelineItems(lane.items.filter(item => item.end >= timelineRange.value.start && item.start <= timelineRange.value.end))
  return { name: lane.name, items, height: Math.max(1, ...items.map(item => item.track + 1)) * 22 }
}))
function timelineStyle(item: TimelineItem & { track: number }): Record<string, string> {
  const range = Math.max(1, timelineRange.value.end - timelineRange.value.start)
  const left = Math.min(99.5, Math.max(0, (item.start - timelineRange.value.start) / range * 100))
  const width = (Math.min(item.end, timelineRange.value.end) - Math.max(item.start, timelineRange.value.start)) / range * 100
  return { left: `${left}%`, width: `${Math.min(100 - left, Math.max(.5, width))}%`, top: `${item.track * 22 + 3}px` }
}
function zoomTimeline(factor: number): void {
  const { start, end } = timelineRange.value
  const center = (start + end) / 2
  const half = Math.max(1, (end - start) * factor) / 2
  const next = fitTraceWindow({ start: center - half, end: center + half }, fullTimelineRange.value)
  zoomWindow.value = next
}
const panPosition = computed(() => {
  const room = fullTimelineRange.value.end - fullTimelineRange.value.start - (timelineRange.value.end - timelineRange.value.start)
  return room > 0 ? (timelineRange.value.start - fullTimelineRange.value.start) / room * 100 : 0
})
function panTimeline(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  const duration = timelineRange.value.end - timelineRange.value.start
  const room = fullTimelineRange.value.end - fullTimelineRange.value.start - duration
  const start = fullTimelineRange.value.start + room * event.target.valueAsNumber / 100
  zoomWindow.value = fitTraceWindow({ start, end: start + duration }, fullTimelineRange.value)
}
function moveTimeline(direction: number): void {
  const { start, end } = timelineRange.value
  const offset = (end - start) * direction
  zoomWindow.value = fitTraceWindow({ start: start + offset, end: end + offset }, fullTimelineRange.value)
}
function formatTime(value?: number): string {
  return value === undefined ? t('Time unavailable') : formatDateTime(new Date(value), { hour12: false })
}
function shortTime(value?: number): string {
  return value === undefined ? t('No timestamp') : formatDateTime(new Date(value), { hour12: false })
}
function batchDescription(event: DiagnosisEvent): string {
  return t('Batch {number} · {count} items', { number: event.batchNumber, count: event.batchSize })
    + '. ' + t('Items with the same batch number came from one LLM call.')
}
function preview(event: DiagnosisEvent): string {
  return (event.content || event.reasoning || t('Empty message')).replace(/\s+/g, ' ').slice(0, 180)
}
function toggleEvent(id: string): void {
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
}
async function selectSpan(span: SessionTraceSpan): Promise<void> {
  selectedId.value = traceKey(span)
  await nextTick()
  document.getElementById(domId('diagnosis-trace'))?.querySelector('.span-inspector')?.scrollIntoView({ block: 'nearest' })
}
function navigateViews(event: KeyboardEvent, view: typeof views[number]['id']): void {
  const index = views.findIndex(item => item.id === view)
  const next = event.key === 'ArrowRight' ? (index + 1) % views.length : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : undefined
  if (next === undefined) return
  event.preventDefault()
  section.value = views[next].id
  document.getElementById(domId(`diagnosis-${section.value}-tab`))?.focus()
}
function url(path: string, params: Record<string, string> = {}): URL {
  const target = apiUrl(props.apiBase, path)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return target
}
async function exportDiagnosis(): Promise<void> {
  if (exportRequest || !props.active || !props.canReadTrace) return
  const controller = new AbortController()
  exportRequest = controller
  exporting.value = true
  exportError.value = ''
  exportStatus.value = ''
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    const result = await fetchDiagnosisExport(props.apiBase, props.sessionId, props.physicalId, signal)
    signal.throwIfAborted()
    const href = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = result.filename
    document.body.append(anchor)
    try { anchor.click() } finally {
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
    }
    exportStatus.value = result.partial
      ? t('Exported a partial snapshot. Follow its pagination and truncation metadata for more evidence; review before sharing.')
      : t('Exported the recorded segment snapshot. Historical prompts may be unavailable; review before sharing.')
  } catch (cause) {
    if (!controller.signal.aborted) exportError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (exportRequest === controller) { exportRequest = undefined; exporting.value = false }
  }
}
async function tracePage(signal: AbortSignal, cursor?: number): Promise<TracePage> {
  const params: Record<string, string> = { sessionId: props.sessionId, limit: '200' }
  if (currentPhysicalId) params.physicalSessionId = currentPhysicalId
  if (cursor !== undefined) params.beforeId = String(cursor)
  return parseTracePage(await fetchDiagnosisJson(url('/v1/query/session-spans', params), signal), props.sessionId, currentPhysicalId)
}
async function refresh(): Promise<void> {
  if (request || !props.active || !props.canReadTrace || !props.sessionId) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
  try {
    const history = parseDiagnosisHistory(await fetchDiagnosisJson(url(`/api/sessions/${encodeURIComponent(props.physicalId || props.sessionId)}`, { shallow: 'true' }), signal))
    signal.throwIfAborted()
    const physical = props.physicalId || history.physicalId
    if (!physical) throw new Error(t('The current physical segment is unavailable; trace data was not fetched.'))
    if (currentPhysicalId !== physical) {
      spans.value = []
      loaded = false
      currentPhysicalId = physical
      selectedId.value = ''
      zoomWindow.value = undefined
      collapsedTurns.clear()
      expanded.clear()
    }
    events.value = history.events
    modelResponses.value = history.modelResponses
    let page = await tracePage(signal)
    const incoming = [...page.entries]
    const known = new Set(spans.value.filter(span => !span.live).map(traceKey))
    // Catch up after a hidden tab or a slow request, without leaving a gap in loaded spans.
    while (loaded && page.hasMore && !page.entries.some(span => known.has(traceKey(span)))) {
      const previous = page.nextBeforeId
      page = await tracePage(signal, previous)
      if (page.hasMore && (page.nextBeforeId === undefined || page.nextBeforeId >= previous!)) throw new Error(t('Trace pagination did not advance.'))
      incoming.push(...page.entries)
    }
    signal.throwIfAborted()
    spans.value = mergeTraceSpans(spans.value, incoming, true)
    if (!loaded || !page.hasMore) {
      hasMore.value = page.hasMore
      beforeId = page.nextBeforeId
    }
    loaded = true
    now.value = Date.now()
    error.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
async function loadEarlier(): Promise<void> {
  if (request || !hasMore.value || beforeId === undefined) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    const page = await tracePage(signal, beforeId)
    signal.throwIfAborted()
    if (page.hasMore && page.nextBeforeId! >= beforeId) throw new Error(t('Trace pagination did not advance.'))
    spans.value = mergeTraceSpans(spans.value, page.entries)
    hasMore.value = page.hasMore
    beforeId = page.nextBeforeId
    error.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
function stop(): void {
  exportRequest?.abort()
  exportRequest = undefined
  exporting.value = false
  request?.abort()
  request = undefined
  loading.value = false
  clearInterval(timer)
  clearInterval(clock)
}
watch(() => [props.sessionId, props.physicalId, props.apiBase], () => {
  stop()
  events.value = []
  modelResponses.value = []
  spans.value = []
  currentPhysicalId = undefined
  beforeId = undefined
  hasMore.value = false
  loaded = false
  error.value = ''
  exportError.value = ''
  exportStatus.value = ''
  query.value = ''
  filter.value = 'ALL'
  selectedId.value = ''
  expanded.clear()
  collapsedTurns.clear()
  zoomWindow.value = undefined
}, { flush: 'sync' })
watch(() => [props.active, props.sessionId, props.physicalId, props.apiBase, props.canReadTrace], () => {
  stop()
  if (!props.active || !props.canReadTrace || !props.sessionId) return
  void refresh()
  timer = setInterval(() => { void refresh() }, 2000)
  clock = setInterval(() => { if (!error.value) now.value = Date.now() }, 250)
}, { immediate: true })
onUnmounted(stop)
</script>

<style scoped>
.session-diagnosis { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; color: var(--c-text); }
.diagnosis-navigation { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--c-border); }
.diagnosis-views { display: flex; gap: 4px; min-width: 0; }
.diagnosis-views button, .event-filters button { display: inline-flex; align-items: center; gap: 7px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); padding: 6px 10px; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.diagnosis-views button.selected, .event-filters button.selected { background: var(--c-bg-muted); color: var(--c-text); }
.view-count { font-size: 10px; color: var(--c-text-muted); }
.diagnosis-status { display: flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--c-text-secondary); font-size: 11px; }
.diagnosis-status.working { color: var(--c-text-secondary); }
.diagnosis-status i, .span-dot { width: 6px; height: 6px; border-radius: var(--radius-circle); background: var(--c-text-secondary); }
.diagnosis-status i, .span-dot.running { animation: trace-pulse 1.6s ease-in-out infinite; }
.diagnosis-scroll { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 24px; overscroll-behavior: contain; }
.trace-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2, h3, h4, p { margin: 0; }
h2 { font-size: 20px; font-weight: 600; letter-spacing: -.025em; }
.trace-heading p { color: var(--c-text-secondary); font-size: 12px; margin-top: 6px; }
.diagnosis-button { border: 1px solid var(--c-border); border-radius: var(--radius-control); padding: 5px 10px; background: var(--c-bg-card); color: var(--c-text-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.diagnosis-button:hover { color: var(--c-text); background: var(--c-bg-soft); }
.diagnosis-button:disabled { opacity: .5; cursor: wait; }
.trace-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin: 24px 0; }
.trace-metrics > div { display: flex; flex-direction: column; gap: 6px; border-left: 2px solid var(--c-border); padding-left: 14px; min-width: 0; }
.trace-metrics strong { font-size: clamp(17px, 2vw, 26px); font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.trace-metrics span { color: var(--c-text-secondary); font-size: 11px; }
.trace-metrics small { font-size: 10px; }
.trace-search { display: flex; align-items: center; gap: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); padding: 9px 12px; }
.trace-search:focus-within { border-color: var(--c-blue); }
.trace-search svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--c-text-secondary); }
.trace-search input { min-width: 0; flex: 1; background: transparent; border: 0; outline: 0; color: var(--c-text); font: inherit; font-size: 12px; }
.trace-search > span { font-size: 10px; color: var(--c-text-secondary); white-space: nowrap; }
.trace-timeline { margin: 20px 0 26px; padding: 14px 16px; background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius-surface); }
.timeline-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-bottom: 14px; }
.timeline-controls > span { margin-right: auto; color: var(--c-text-secondary); font-size: 11px; }
.timeline-controls small { display: block; margin-top: 4px; font-size: 10px; }
.timeline-controls button { padding: 3px 8px; }
.timeline-controls button:disabled, .timeline-pan button:disabled { cursor: default; }
.timeline-pan { display: flex; align-items: center; gap: 12px; margin-top: 12px; color: var(--c-text-secondary); font-size: 10px; }
.timeline-pan label { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.timeline-pan input { flex: 1; min-width: 0; accent-color: var(--c-blue); }
.timeline-hover-title { display: block; font-size: 12px; font-weight: 600; }
.timeline-hover-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 6px 12px; margin: 10px 0 0; font-size: 11px; }
.timeline-hover-meta dt { color: var(--c-text-secondary); }
.timeline-hover-meta dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.timeline-scale, .timeline-lane { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 14px; align-items: center; font-size: 11px; color: var(--c-text-secondary); }
.timeline-scale { margin-bottom: 10px; font-size: 10px; font-variant-numeric: tabular-nums; }
.timeline-scale > div { display: flex; justify-content: space-between; }
.timeline-lane { min-height: 33px; }
.lane-track { position: relative; height: 22px; background: repeating-linear-gradient(90deg, var(--c-border) 0 1px, transparent 1px 25%); border-radius: var(--radius-sm); }
.lane-bar { position: absolute; top: 3px; height: 16px; min-width: 3px; padding: 0; border: 0; border-radius: var(--radius-sm); background: #6e8de0; cursor: pointer; }
.lane-bar.input { background: #848b96; }
.lane-bar.tools { background: #bb944f; }
.lane-bar.failed { background: var(--c-error, #db6565); }
.lane-bar:hover, .lane-bar.picked { outline: 2px solid var(--c-text); outline-offset: 1px; z-index: 1; }
.lane-bar.dimmed { opacity: .2; }
.lane-bar.running { animation: trace-pulse 1.6s ease-in-out infinite; }
.timeline-note, .trace-footnote { color: var(--c-text-secondary); font-size: 11px; line-height: 1.6; margin-top: 12px; }
.events-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
h3 { font-size: 14px; font-weight: 550; }
.events-heading > span { font-size: 11px; color: var(--c-text-secondary); }
.event-fold-controls { display: flex; gap: 6px; margin-left: auto; }
.event-filters { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 14px; }
.event-filters button { padding: 4px 8px; font-size: 11px; text-transform: capitalize; }
.trace-turn { margin-bottom: 16px; }
.turn-heading { display: flex; justify-content: space-between; width: 100%; background: transparent; border: 0; border-bottom: 1px solid var(--c-border); padding: 9px 2px; color: var(--c-text-secondary); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; cursor: pointer; }
.turn-heading > span:last-child { font-size: 9px; opacity: .7; }
.trace-event { border-bottom: 1px solid var(--c-border); }
.trace-event.highlighted { outline: 1px solid var(--c-blue); outline-offset: -1px; }
.trace-event-header { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 6px; text-align: left; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.trace-event-header:hover, .trace-event.expanded { background: var(--c-bg-soft); }
.event-chevron { font-size: 12px; width: 8px; flex-shrink: 0; }
.event-batch-indicator { position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--batch-color); }
.trace-event-header { position: relative; padding-left: 10px; }
.batch-color-0 { --batch-color: #426bb5; }
.batch-color-1 { --batch-color: #96702d; }
.batch-color-2 { --batch-color: #398175; }
.batch-color-3 { --batch-color: #9165ab; }
.batch-color-4 { --batch-color: #b25f70; }
:global(.dark .session-diagnosis .batch-color-0) { --batch-color: #89aff0; }
:global(.dark .session-diagnosis .batch-color-1) { --batch-color: #d5b16d; }
:global(.dark .session-diagnosis .batch-color-2) { --batch-color: #79bfb1; }
:global(.dark .session-diagnosis .batch-color-3) { --batch-color: #bd98d4; }
:global(.dark .session-diagnosis .batch-color-4) { --batch-color: #dc94a3; }
.batch-description { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.event-kind { flex: 0 0 auto; display: inline-block; color: var(--c-text-secondary); background: var(--c-bg-muted); font: 600 9px ui-monospace, monospace; letter-spacing: .045em; padding: 4px 6px; border-radius: var(--radius-sm); }
.event-origin { max-width: 25%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--c-text-secondary); }
.event-name { max-width: 25%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text); font-size: 11px; font-weight: 500; }
.event-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.event-time, .event-duration { font-size: 10px; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--c-text-secondary); }
.trace-event-detail { padding: 8px 18px 16px 30px; }
pre { margin: 8px 0 12px; padding: 12px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text-secondary); font: 11px/1.65 ui-monospace, monospace; }
h4, summary { font-size: 11px; font-weight: 500; color: var(--c-text-secondary); }
summary { cursor: pointer; padding: 8px 0; }
.event-call-id { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; font: 10px ui-monospace, monospace; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.missing-detail { margin: 8px 0; color: var(--c-text-secondary); font-size: 12px; }
.span-inspector { border: 1px solid color-mix(in srgb, var(--c-blue) 30%, var(--c-border)); border-radius: var(--radius-surface); padding: 14px; margin-bottom: 24px; }
.inspector-heading { display: flex; align-items: center; gap: 9px; min-width: 0; font-size: 12px; }
.inspector-heading strong { flex: 1; overflow-wrap: anywhere; font-weight: 500; }
.inspector-heading > span:not(.event-kind) { font-size: 11px; white-space: nowrap; color: var(--c-text-secondary); }
.span-identity { display: grid; grid-template-columns: 55px minmax(0, 1fr); gap: 6px; color: var(--c-text-secondary); font: 10px/1.6 ui-monospace, monospace; margin: 14px 0; }
.span-identity dd { margin: 0; overflow-wrap: anywhere; }
.span-identity dt { opacity: .7; }
.all-spans { margin-top: 22px; border-top: 1px solid var(--c-border); }
.all-spans > summary { font-size: 12px; padding: 14px 0; }
.all-spans > summary span { margin-left: 6px; color: var(--c-text-muted); font-size: 10px; }
.span-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 6px; text-align: left; border: 0; border-bottom: 1px solid var(--c-border); background: transparent; color: var(--c-text-secondary); font: 11px ui-monospace, monospace; cursor: pointer; }
.span-row:hover { background: var(--c-bg-soft); }
.span-row strong { font-weight: 500; }
.span-row > span:nth-last-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.span-row > span:last-child { margin-left: auto; flex-shrink: 0; }
.span-row.failed .span-dot { background: var(--c-error, #db6565); }
.span-dot { flex-shrink: 0; }
.load-earlier { margin: 16px 0; }
.diagnosis-empty { padding: 28px 12px; text-align: center; color: var(--c-text-secondary); font-size: 12px; line-height: 1.7; }
.diagnosis-error { border: 1px solid var(--c-error, #db6565); border-radius: var(--radius-surface); color: var(--c-error, #db6565); padding: 10px 12px; margin-top: 16px; font-size: 12px; line-height: 1.6; }
.context-note { color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; margin-bottom: 20px; }
.context-view > :deep(div) { margin-bottom: 16px; }
.context-view :deep(.system-prompt-content) { font-size: 13px; }
button:focus-visible, [tabindex="0"]:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@keyframes trace-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .diagnosis-status i, .span-dot.running, .lane-bar.running { animation: none; } }
@media (max-width: 700px) {
  .diagnosis-navigation { padding: 10px 12px; gap: 5px; flex-wrap: wrap; }
  .diagnosis-scroll { padding: 18px 12px; }
  .trace-metrics { gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .event-time { display: none; }
  .trace-event-header { gap: 6px; }
  .event-kind { font-size: 8px; }
  .trace-event-detail { padding-left: 12px; padding-right: 12px; }
  .trace-timeline { padding: 12px; }
  .timeline-scale, .timeline-lane { grid-template-columns: 40px minmax(0, 1fr); gap: 10px; }
  .events-heading { flex-wrap: wrap; }
}
</style>
