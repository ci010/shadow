<template>
  <div class="bot-inspection">
    <header class="bot-heading">
      <div><h2>{{ displayName }}</h2><p>{{ entry.graph?.[0]?.nodeType === 'connection' ? t('Connection') : t('Published BOT / Agent') }}</p></div>
      <HoverInfo :text="t('Close')" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="btn btn-ghost btn-sm close-action" :aria-label="t('Close')" @click="$emit('close')"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
    </header>
    <p v-if="referenceUnavailable" class="bot-explanation" role="status">{{ t('Selected object cannot be referenced. Refresh and select a current published object.') }}</p>
    <p class="bot-explanation">{{ entry.sinkProjection && !relatedNodes.some(node => node.nodeType === 'deployment') ? t('Records messages without model reactions') : t('Connection health is not delivery success. BOT entries show configuration; receipt and execution remain unknown.') }}</p>
    <nav class="bot-actions" :aria-label="t('Connection')">
      <RouterLink v-if="entry.connectionSettingsId" class="btn btn-sm" :aria-label="t('Configure BOT connection')" :to="{ name: 'project-settings', params: { projectId, section: 'connections' }, query: { connectionId: entry.connectionSettingsId } }">{{ t('Configure BOT connection') }}<span class="i-lucide-arrow-up-right" aria-hidden="true" /></RouterLink>
      <p v-else>{{ t('Connection unavailable') }}</p>
    </nav>
    <dl v-if="connection" class="connection-summary"><dt>{{ t('Platform') }}</dt><dd>{{ connection.platform }}</dd><dt>{{ t('Connection state') }}</dt><dd>{{ channelStateLabel({ state: connection.health, configured: true }) }}</dd><dt>{{ t('Configuration') }}</dt><dd>{{ connection.enabled ? t('Enabled') : t('Disabled') }}</dd></dl>
    <template v-if="entry.sinkProjection">
      <section class="bot-section receiver-directory">
        <h3>{{ t('Message receivers') }} <span>{{ entry.sinkProjection.receivers.length }}</span></h3>
        <p v-if="!entry.sinkProjection.receivers.length">{{ t('No received conversations yet') }}</p>
        <ul class="receiver-list"><li v-for="receiver in entry.sinkProjection.receivers" :key="receiver.id" :data-selected="selectedNode === `receiver:${receiver.id}`">
          <button class="receiver-choice" :aria-pressed="selectedNode === `receiver:${receiver.id}`" @click="$emit('select', `receiver:${receiver.id}`)"><span class="i-lucide-messages-square" aria-hidden="true" /><span>{{ receiverLabel(receiver) }}</span><span class="receiver-platform">{{ receiver.address.platform }}</span></button>
          <p class="receiver-evidence">{{ entry.graph?.find(node => node.id === `receiver:${receiver.id}`)?.description }}</p>
          <RouterLink v-if="sinkNavigationLocation(receiver.navigation)" class="history-link" :to="sinkNavigationLocation(receiver.navigation)!">{{ sinkNavigationLabel(receiver.navigation) }}<span class="i-lucide-arrow-up-right" aria-hidden="true" /></RouterLink>
          <p v-else>{{ t('Channel metadata unavailable. Waiting for received content.') }}</p>
        </li></ul>
      </section>
      <section class="bot-section"><h3>{{ t('Associated BOTs') }} <span>{{ associatedBotCount }}</span></h3><p>{{ t('BOT associations are configuration, not execution evidence.') }}</p><p v-if="!associatedBotCount">{{ t('No BOT association recorded') }}</p></section>
    </template>
    <template v-if="!entry.sinkProjection || relatedNodes.length">
      <section v-for="node in relatedNodes" :key="node.id" class="bot-section" :data-node="node.id" :data-selected="selectedNode === node.id">
        <h3><button class="bot-choice" :aria-pressed="selectedNode === node.id" @click="$emit('select', node.id)">{{ node.nodeType === 'deployment' ? field(deployment(node.config), 'agent') || node.label : node.label }}</button></h3>
        <dl v-if="node.nodeType === 'connection'"><dt>{{ t('Platform') }}</dt><dd>{{ field(node.config, 'platform') || t('Unavailable') }}</dd><dt>{{ t('Connection state') }}</dt><dd>{{ connectionState(node.config) }}</dd></dl>
        <dl v-else-if="node.nodeType === 'deployment'"><dt>{{ t('BOT entry configuration') }}</dt><dd>{{ entryLabel(node) }}</dd><dt>{{ t('Mode') }}</dt><dd>{{ field(deployment(node.config), 'mode') || t('Unavailable') }}</dd><dt>{{ t('Package state') }}</dt><dd>{{ packageState(node.config) }}</dd><template v-if="field(node.config, 'kind')"><dt>{{ t('Entry type') }}</dt><dd>{{ field(node.config, 'kind') === 'host-owner-ingress' ? t('Host owner ingress') : t('Conversation entry') }}</dd><dt>{{ t('Configuration') }}</dt><dd>{{ flag(node.config, 'enabled', 'Enabled', 'Disabled') }}</dd><dt>{{ t('Subscription') }}</dt><dd>{{ flag(node.config, 'subscribed', 'Subscribed', 'Not subscribed') }}</dd><dt>{{ t('Listener') }}</dt><dd>{{ flag(node.config, 'listener', 'Listener projected', 'No listener') }}</dd></template></dl>
        <p v-else>{{ node.nodeType === 'session' ? t('Existing conversation recorded') : t('Configured entry; receipt unknown') }}</p>
        <div v-if="node.nodeType === 'deployment' && executionSessions(node.config).length" class="execution-sessions">
          <h4>{{ t('Execution sessions') }}</h4><p>{{ t('Existing BOT execution conversations, separate from passive message history. Not execution receipts.') }}</p>
          <RouterLink v-for="sessionId in executionSessions(node.config)" :key="sessionId" class="history-link" :to="{ name: 'chat', params: { projectId, sessionId } }">{{ sessionId }}<span class="i-lucide-arrow-up-right" aria-hidden="true" /></RouterLink>
        </div>
        <OpenBotPromptButton v-if="node.nodeType === 'deployment' && field(deployment(node.config), 'id')" :api-base="apiBase" :project-id="projectId" :bot-id="field(deployment(node.config), 'id')" :revision="field(deployment(node.config), 'revision')" />
        <p v-if="node.description" class="node-evidence">{{ node.description }}</p>
        <RouterLink v-if="node.targetSessionId" class="history-link" :to="{ name: 'chat', params: { projectId, sessionId: node.targetSessionId } }">{{ t('Open conversation') }}</RouterLink>
      </section>
    </template>
    <details :key="entry.definition.id" class="bot-technical">
      <summary>{{ t('Technical details') }}</summary>
      <template v-if="entry.sinkProjection"><dl><dt>{{ t('Connection ID') }}</dt><dd><code>{{ entry.sinkProjection.connectionId }}</code></dd><dt>{{ t('Agent resource') }}</dt><dd><code>{{ entry.sinkProjection.sinkPath }}</code><br /><code>{{ entry.sinkProjection.guidePath }}</code></dd></dl><pre>{{ JSON.stringify(entry.sinkProjection.bots, null, 2) }}</pre></template>
      <details v-for="node in entry.graph" :key="node.id" class="node-technical"><summary>{{ node.label }} · {{ node.detail }}</summary><p v-if="node.description">{{ node.description }}</p><pre>{{ JSON.stringify(node.config, null, 2) }}</pre></details>
    </details>
  </div>
</template>
<script setup lang="ts">
import OpenBotPromptButton from './OpenBotPromptButton.vue'
import { receiverLabel } from '../receiver-label.ts'
import { computed } from 'vue'
import { configuredTarget, type BotProjection } from '../bot-workflows.ts'
import type { WorkflowCanvasEntry } from '../workflow-canvas.ts'
import { sinkNavigationLabel, sinkNavigationLocation } from '../connection-sinks.ts'
import { channelStateLabel } from '../channel-settings.ts'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
const props = defineProps<{ entry: WorkflowCanvasEntry; projectId: string; apiBase: string; connection?: BotProjection['connections'][number]; selectedNode?: string; referenceUnavailable?: boolean }>()
defineEmits<{ close: []; select: [id: string] }>()
const displayName = computed(() => {
  const connection = props.connection
  if (connection?.displayName && connection.displayName !== connection.id) return connection.displayName
  const sink = props.entry.sinkProjection
  if (sink && props.entry.definition.name !== sink.connectionId) return props.entry.definition.name
  return props.entry.graph?.[0]?.nodeType === 'connection' ? t('Connection') : field(deployment(props.entry.graph?.[0]?.config), 'agent') || t('Published BOT / Agent')
})
function field(config: unknown, key: string): string { const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined; return typeof value === 'string' ? value : '' }
const associatedBotCount = computed(() => new Set([...(props.entry.sinkProjection?.bots.map(bot => bot.botId) ?? []), ...(props.entry.graph ?? []).filter(node => node.nodeType === 'deployment').map(node => field(deployment(node.config), 'id')).filter(Boolean)]).size)
function entryLabel(node: NonNullable<WorkflowCanvasEntry['graph']>[number]) {
  const receiver = props.entry.sinkProjection?.receivers.find(receiver => receiver.id === node.receiverId)
  return receiver ? receiverLabel(receiver) : configuredTarget({ platform: field(node.config, 'platform'), topic: field(node.config, 'topic'), kind: field(node.config, 'kind') })
}
function executionSessions(config: unknown): string[] {
  const ids = config && typeof config === 'object' ? (config as Record<string, unknown>).sessionIds : undefined
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

const relatedNodes = computed(() => (props.entry.graph ?? []).filter(node => node.nodeType === 'deployment' || node.nodeType === 'session'))
function deployment(config: unknown): unknown { return config && typeof config === 'object' ? (config as Record<string, unknown>).deployment : undefined }
function packageState(config: unknown) { const state = field(deployment(config), 'state'); return state === 'valid' ? t('Validated package') : state === 'quarantined' ? t('Quarantined package') : t('Unavailable') }
function flag(config: unknown, key: string, yes: Parameters<typeof t>[0], no: Parameters<typeof t>[0]) { const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined; return value === true ? t(yes) : value === false ? t(no) : t('Unavailable') }
function connectionState(config: unknown) { const state = field(config, 'health'); return state ? channelStateLabel({ state: state as Parameters<typeof channelStateLabel>[0]['state'], configured: true }) : t('Unavailable') }
</script>
<style scoped>
.bot-inspection { min-width: 0; line-height: 1.6; }
.bot-heading { position: sticky; top: -16px; z-index: 1; margin: -16px -16px 0; padding: 16px; background: var(--c-bg-card); border-bottom: 1px solid var(--c-border-soft); display: flex; justify-content: space-between; align-items: start; gap: 12px; }
.bot-heading>div { min-width: 0; }.bot-heading h2 { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }.bot-heading p { color: var(--c-text-secondary); font-size: 12px; }
p { margin: 0; color: var(--c-text-secondary); }.bot-explanation { margin-top: 16px; }.close-action { padding: 6px; min-width: 32px; }
.bot-actions { margin: 16px 0 24px; }.bot-actions a { display: inline-flex; gap: 8px; align-items: center; white-space: normal; }
.bot-section { margin-top: 24px; }.bot-section[data-selected=true] { border-top: 1px solid var(--c-selection-border); padding-top: 12px; }.bot-section h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }.bot-section h3>span { font-weight: 400; color: var(--c-text-muted); }
.receiver-list { list-style: none; padding: 0; margin: 0; }.receiver-list li { border-top: 1px solid var(--c-border-soft); padding: 10px 0 14px; }.receiver-choice { width: 100%; display: flex; align-items: center; gap: 8px; text-align: start; color: var(--c-text); font: inherit; background: transparent; border: 0; cursor: pointer; min-height: 32px; padding: 4px; }.receiver-choice>span:nth-child(2) { flex: 1; min-width: 0; overflow-wrap: anywhere; }.receiver-choice>span:first-child { flex-shrink: 0; }.receiver-platform { color: var(--c-text-secondary); font-size: 12px; }.receiver-choice:hover { background: var(--c-bg-muted); }.receiver-choice[aria-pressed=true] { color: var(--c-primary); background: var(--c-selection-bg); }.receiver-evidence { margin: 6px 0; font-size: 12px; }.history-link { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; color: var(--c-primary); }
.execution-sessions h4 { margin: 16px 0 6px; font-size: 13px; }.execution-sessions a { display: flex; overflow-wrap: anywhere; }
.bot-choice { font: inherit; text-align: start; color: inherit; border: 1px solid var(--c-border); background: transparent; padding: 6px 8px; cursor: pointer; min-height: 32px; width: 100%; overflow-wrap: anywhere; }.bot-choice[aria-pressed=true] { border-color: var(--c-primary); background: var(--c-selection-bg); color: var(--c-primary); }
.bot-technical { margin-top: 24px; border-top: 1px solid var(--c-border); }.bot-technical summary { cursor: pointer; min-height: 44px; padding: 10px 0; box-sizing: border-box; overflow-wrap: anywhere; }.node-technical { border-top: 1px solid var(--c-border-soft); }.node-technical summary { color: var(--c-text-secondary); }
dl { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); gap: 8px 16px; margin: 12px 0; }dt { color: var(--c-text-secondary); }dd { margin: 0; overflow-wrap: anywhere; }code, pre { font-size: 12px; overflow-wrap: anywhere; }pre { padding: 12px; background: var(--c-bg-soft); color: var(--c-text-body); white-space: pre-wrap; overflow: auto; max-height: 280px; }button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { .receiver-choice, .history-link, .close-action, .bot-choice { min-height: 44px; }.close-action { min-width: 44px; } }
</style>
