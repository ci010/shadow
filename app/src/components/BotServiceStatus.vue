<template>
  <section class="service-status" :aria-label="t('Saved service access')">
    <button type="button" :disabled="loading" @click="refresh">{{ t('Refresh status') }}</button>
    <p>{{ t('Read-only deployed access. Connection status does not verify assignments or grant permissions. Configure BOT files in chat and review the exact deployment before applying changes.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="overview">
      <p v-for="issue in overview.deploymentIssues" :key="issue.agentId" role="status">{{ issue.agentId }} · {{ issue.message }}</p>
      <h4>{{ t('Saved assignments') }}</h4>
      <p v-if="!bindings.length">{{ t('No channels or DMs are assigned to this Bot.') }}</p>
      <details v-for="binding in bindings" :key="binding.id"><summary>{{ bindingLabel(binding, []) }} · {{ binding.enabled ? t('Enabled') : t('Disabled') }}</summary><pre>{{ JSON.stringify(binding, null, 2) }}</pre></details>
      <h4>{{ t('Agents') }}</h4>
      <details v-for="agent in agents" :key="agent.id"><summary>{{ agent.displayName }}</summary><pre>{{ agent.markdown }}</pre></details>
      <h4>{{ t('Knowledge') }}</h4>
      <p>{{ t('Shared only by explicit publication.') }}</p>
      <details v-for="resource in overview.resources.filter(item => item.publication)" :key="resource.id"><summary>{{ resource.title }} · {{ resource.revoked ? t('Revoked') : t('Published') }}</summary><button type="button" :disabled="loading" @click="readResource(resource.id)">{{ t('Read published copy') }}</button><pre v-if="contents[resource.id]">{{ contents[resource.id] }}</pre></details>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { bindingLabel, createDiscordIntegrationClient } from '../discord-integration.ts'
import type { IntegrationOverview } from '../../../src/channels/integration-contract.ts'
const props = defineProps<{ apiBase: string; projectId: string; botId: string }>()
const overview = ref<IntegrationOverview>(), contents = ref<Record<string, string>>({}), error = ref(''), loading = ref(false)
const bindings = computed(() => overview.value?.bindings.filter(item => item.botInstanceId === props.botId) ?? [])
const agents = computed(() => overview.value?.agents.filter(item => bindings.value.some(binding => binding.agentId === item.id)) ?? [])
let request: AbortController | undefined
function stop() { request?.abort(); request = undefined; overview.value = undefined; contents.value = {}; error.value = ''; loading.value = false }
async function load(action: (client: ReturnType<typeof createDiscordIntegrationClient>, signal: AbortSignal) => Promise<void>) {
  request?.abort(); const controller = new AbortController(); request = controller; loading.value = true; error.value = ''
  try { await action(createDiscordIntegrationClient(props.apiBase, props.projectId), controller.signal) }
  catch { if (!controller.signal.aborted) error.value = t('Could not load saved service access. Refresh to retry.') }
  finally { if (request === controller) { request = undefined; loading.value = false } }
}
async function refresh() { await load(async (client, signal) => { const value = await client.overview(signal); if (!signal.aborted) { overview.value = value; contents.value = {} } }) }
async function readResource(id: string) { await load(async (client, signal) => { const value = await client.resource(id, signal); if (!signal.aborted) contents.value[id] = value.content }) }
watch(() => [props.apiBase, props.projectId, props.botId], () => { stop(); void refresh() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(stop)
</script>
<style scoped>
.service-status { font-size: 13px; overflow-wrap: anywhere; }
p { color: var(--c-text-secondary); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; font-size: 12px; background: var(--c-bg-muted); padding: 12px; }
summary { padding-block: 8px; cursor: pointer; }
button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .6; cursor: not-allowed; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { button, summary { min-height: 44px; box-sizing: border-box; } }
</style>
