<template>
  <section class="topic-history" :aria-label="t('Topic history')">
    <p class="notice">{{ t('Past and present topics. Reports and execution status are not user acceptance.') }}</p>
    <p v-if="data.focus" class="notice">{{ t('Organized at') }} {{ new Date(data.focus.inferredAt).toLocaleString() }} · {{ data.focus.inputCount }} {{ t('topics considered') }} · {{ data.focus.omittedCount }} {{ t('outside the input window') }}</p>
    <p v-if="!focusGroups.length">{{ t('No recorded topics yet') }}</p>
    <section v-for="group in focusGroups" :key="group.key" class="focus-group">
      <header><h2>{{ group.inferred ? group.title : t('Unclassified topics') }} <small>· {{ group.topics.length }}</small></h2>
        <p v-if="group.inferred" class="notice">{{ t('Model interpretation — not confirmed user intent') }} · {{ data.focus ? t('User-triggered organization') : t('Latest topic interpretation') }}</p>
        <p>{{ group.inferred ? group.purpose : t('No semantic inference saved. These topics remain separate; historical records are not backfilled.') }}</p>
        <p v-if="group.inferred"><strong>{{ t('Inferred motivation') }}:</strong> {{ group.motivation }}</p>
        <p v-if="group.stale" class="notice">{{ t('Topics changed since organization. This interpretation may be stale.') }}</p>
        <details v-if="data.focus && group.inferred" class="group-sources"><summary>{{ t('Evidence') }}</summary><p v-for="topic in group.topics" :key="topic.key">{{ topic.title }} · {{ topic.key }} · {{ t('Note version') }} {{ data.focus.sources.find(source => source.key === topic.key)?.sequence }}</p></details>
      </header>
    <details v-for="topic in group.topics" :key="topic.key" @toggle="onToggle($event, topic)">
      <summary><span class="toggle-marker" aria-hidden="true">▸</span><strong>{{ topic.title }}</strong><span>{{ topic.root ? (topic.root.observation && topic.root.status === 'done' ? t('Execution ended') : t('Reported state') + ': ' + workStatus(topic.root)) : t('Session-derived topic') }}</span><span v-for="activity in [...new Set(topic.sessions.map(session => session.activity))]" :key="activity">{{ t('Execution') }}: {{ sessionActivity(activity).label }}</span><time>{{ topic.changedAt ? new Date(topic.changedAt).toLocaleString() : '' }}</time><span class="latest-report">{{ topic.root?.notes?.summary || topic.root?.objective || t('No recorded outcome summary. Open the conversation for evidence.') }}</span></summary>
      <div v-if="topic.root?.observation?.focus" class="focus-evidence">
        <p class="notice">{{ t('Model interpretation — not confirmed user intent') }}</p>
        <p><strong>{{ t('Inferred motivation') }}:</strong> {{ topic.root.observation.focus.motivation }}</p>
        <p>{{ topic.root.observation.focus.purpose }}</p>
        <small>{{ t('Evidence') }} · {{ topic.root.observation.sessionId }} · {{ topic.root.observation.observedAt }} · {{ topic.root.observation.focus.evidence.map(source => source.physicalId + '/' + source.id).join(', ') }}</small>
      </div>
      <p class="report">{{ topic.root?.notes?.summary || topic.root?.objective || t('No recorded outcome summary. Open the conversation for evidence.') }}</p>
      <p v-if="topic.root?.blockedReason">{{ t('Blocked') }}: {{ topic.root.blockedReason }}</p>
      <p v-if="topic.root?.notes?.next">{{ t('Next') }}: {{ topic.root.notes.next }}</p>
      <p v-if="topic.fallback" class="notice">{{ t('This label comes from a session, not a verified topic boundary.') }}</p>
      <p v-if="!topic.items.some(item => item.notes?.relation || item.dependencies.length)" class="notice">{{ t('No saved causal relationships for this topic.') }}</p>
      <h3 v-if="topic.items.length">{{ t('Internal structure') }}</h3>
      <ul><li v-for="item in topic.items" :key="item.key" :style="{ marginInlineStart: `${(workPath(topic.items, item.key).length - 1) * 16}px` }"><button @click="emit('select', item.key)">{{ item.title }}</button> · {{ item.notes?.kind ? workKind(item.notes.kind) : t('No saved work role') }} · {{ workStatus(item) }}
        <p v-if="item.notes?.relation">{{ relationLabel(item.notes.relation.kind) }}: {{ item.notes.relation.reason }}</p>
        <p v-if="item.parentKey">{{ t('Parent work') }}: <button @click="emit('select', item.parentKey)">{{ data.items.find(value => value.key === item.parentKey)?.title ?? item.parentKey }}</button></p>
        <p v-if="item.dependencies.length">{{ t('Depends on:') }} <button v-for="key in item.dependencies" :key="key" @click="emit('select', key)">{{ data.items.find(value => value.key === key)?.title ?? key }}{{ topic.items.some(value => value.key === key) ? '' : ' · ' + t('Cross-topic dependency') }}</button></p>
        <p v-if="item.notes?.summary">{{ item.notes.summary }}</p>
        <small v-if="item.observation">{{ t('Observer interpretation') }} · {{ item.observation.sessionId }} · {{ item.observation.sources.map(source => source.physicalId + '/' + source.id).join(', ') }}</small>
      </li></ul>
      <h3>{{ t('Conversations and execution') }}</h3>
      <ul><li v-for="session in topic.sessions" :key="session.sessionId"><button @click="emit('session', session.sessionId)">{{ session.title }}</button> · {{ sessionActivity(session.activity).label }}</li></ul>
      <h3>{{ t('Recorded decisions') }}</h3>
      <p class="notice">{{ t('Only saved answers are decisions. Pending questions, chosen approaches and timeout defaults are distinct.') }}</p>
      <div v-for="session in topic.sessions" :key="session.sessionId">
        <p class="notice">{{ session.title }} · {{ t('Session history may include decisions from other topics.') }}</p>
        <p v-if="!history[session.sessionId]">{{ t('Loading…') }}</p>
        <template v-else>
          <p v-if="history[session.sessionId].error" role="alert">{{ t('Decision history unavailable') }} <button @click="load(session.sessionId)">{{ t('Retry') }}</button></p>
          <p v-if="history[session.sessionId].limited">{{ t('History is partial: older records or unreadable segments are not shown.') }}</p>
          <article v-for="record in history[session.sessionId].records" :key="record.request.origin?.physicalId + ':' + record.request.id">
            <strong>{{ record.request.question }}</strong>
            <p v-if="record.request.workContext" class="notice">{{ record.request.workContext.path.map(node => node.title).join(' → ') }}</p>
            <p>{{ record.answer ? actor(record.answer.answeredBy) + ': ' + record.answer.option : record.closed ? t('Closed without an answer') + ': ' + record.closed.reason : t('Pending — no decision recorded') }}</p>
            <p v-if="record.invalidated">{{ t('Invalidated') }}: {{ record.invalidated.reason }}</p>
            <small>{{ session.title }} · {{ record.answer?.answeredAt ?? record.request.createdAt }} · {{ record.request.origin?.physicalId }} / {{ record.request.id }}</small>
          </article>
          <p v-if="!history[session.sessionId].error && !history[session.sessionId].records.length">{{ t('No saved decision records in the available history.') }}</p>
        </template>
      </div>
    </details>
    </section>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectWorkOverview } from '../../../src/projects/work-overview.ts'
import { parseYieldDecisionRecord, type YieldDecisionRecord } from '../../../src/sessions/yield-contract.ts'
import { sessionActivity } from '../session-activity.ts'
import { projectFocusGroups, projectTopics } from '../project-topic-history.ts'
import { relationLabel, workKind, workStatus, workPath } from '../project-work.ts'
const props = defineProps<{ data: ProjectWorkOverview; apiBase: string; query: string }>()
const emit = defineEmits<{ select: [key: string]; session: [id: string] }>()
const topics = computed(() => projectTopics(props.data).filter(topic => !props.query.trim() ||
  [topic.title, topic.root?.observation?.focus?.category ?? '', topic.root?.observation?.focus?.motivation ?? '', topic.root?.observation?.focus?.purpose ?? '', ...topic.items.map(item => `${item.title} ${item.notes?.summary ?? ''}`)].join(' ').toLowerCase().includes(props.query.trim().toLowerCase())))
const focusGroups = computed(() => {
  const query = props.query.trim().toLowerCase(), matched = new Set(topics.value.map(topic => topic.key))
  return projectFocusGroups(projectTopics(props.data), props.data.focus).map(group => ({ ...group,
    topics: !query || `${group.title} ${group.purpose} ${group.motivation}`.toLowerCase().includes(query)
      ? group.topics : group.topics.filter(topic => matched.has(topic.key)),
  })).filter(group => group.topics.length)
})
const history = reactive<Record<string, { records: YieldDecisionRecord[]; error?: boolean; limited?: boolean }>>({})
let generation = 0
watch(() => props.apiBase, () => { generation++; for (const key of Object.keys(history)) delete history[key] })
function actor(value: 'user' | 'parent' | 'timeout') { return value === 'user' ? t('Human answer') : value === 'parent' ? t('Parent model answer') : t('Timeout default (not a human or model choice)') }
async function load(id: string) {
  const current = generation
  try {
    const response = await fetch(`${props.apiBase}/api/work-history?sessionId=${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error('unavailable')
    const value = await response.json()
    const records = value.records.map(parseYieldDecisionRecord)
    if (current === generation) history[id] = { records, limited: value.truncated || value.errors.length > 0 }
  } catch { if (current === generation) history[id] = { records: [], error: true } }
}
function onToggle(event: Event, topic: ReturnType<typeof projectTopics>[number]) {
  if ((event.target as HTMLDetailsElement).open) for (const session of topic.sessions) void load(session.sessionId)
}
</script>
<style scoped>
.topic-history { overflow: auto; padding: 16px; min-height: 0; }
.focus-group + .focus-group { margin-top: 24px; }
.focus-group > header { padding-bottom: 8px; }
h2 { margin: 0; font-size: 17px; }
.focus-evidence { padding: 10px; background: var(--c-bg-soft); border-inline-start: 3px solid var(--c-border); margin-top: 12px; }
.focus-evidence small { overflow-wrap: anywhere; }
.notice, small, time { color: var(--c-text-secondary); font-size: 12px; }
details { border: 1px solid var(--c-border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
summary { cursor: pointer; display: flex; gap: 12px; flex-wrap: wrap; }
summary .latest-report { flex-basis: 100%; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.toggle-marker { transition: transform .12s; } details[open] .toggle-marker { transform: rotate(90deg); }
summary strong { flex: 1; } summary span { font-size: 12px; }
p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
h3 { font-size: 13px; margin-top: 20px; } li { margin-bottom: 12px; font-size: 13px; }
button { color: var(--c-primary); background: transparent; border: 1px solid var(--c-border); border-radius: 4px; padding: 6px; cursor: pointer; }
article { border-top: 1px solid var(--c-border); padding: 12px 0; font-size: 13px; }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); }
</style>
