<template>
  <section class="channel-group-context" :aria-label="t('Service group')">
    <p v-if="error" role="alert">{{ t('Could not load service groups. Retry.') }} <button class="btn btn-sm" @click="refresh">{{ t('Retry') }}</button></p>
    <template v-if="group">
      <header class="group-toolbar">
        <strong v-if="discoveryOnly" :title="group.conversationId">{{ groupDisplayName(group) }}</strong>
        <span class="group-status" :title="group.enabled ? t('Enabled — ordinary received messages do not trigger a reply unless the Bot trigger policy allows it.') : t('Not enabled — received messages do not trigger an Agent or a reply.')">{{ t('Quietly observing') }}</span>
        <ComposerPopover :key="group.botInstanceId + group.conversationId" :label="t('Group Agent setup')" :width="380"><template #trigger><span class="i-lucide-settings-2" aria-hidden="true" /><span>{{ t('Settings') }}</span></template><div class="group-setup">
          <form v-if="agents.length" @submit.prevent="propose()">
            <label>{{ t('Agent') }} <UiSelect v-model="agent" :disabled="busy || group.pending"><option value="" disabled>{{ t('Select an Agent') }}</option><option v-for="name in agents" :key="name" :value="name">{{ name }}</option></UiSelect></label>
            <template v-if="setup">
              <p>{{ setup.status === 'ready' ? t('Ready to enable') : t('Agent setup incomplete') }}</p>
              <template v-if="setup.summary">
                <p v-if="!setup.summary.tools.length && !setup.summary.reads.length && !setup.summary.targets.length && !setup.summary.hostModules?.length">{{ t('No tools or external access') }}</p>
                <p v-for="tool in setup.summary.tools" :key="tool.name"><strong>{{ tool.name }}</strong> — {{ tool.description }}</p>
                <p v-if="setup.summary.hostModules?.length">{{ t('Host access outside scoped grants') }}: {{ setup.summary.hostModules.join(', ') }}. {{ t('Native modules are not restricted by read-only folders or HTTP routes.') }}</p>
                <p v-if="setup.summary.reads.length">{{ t('Read-only folders') }}: {{ setup.summary.readFolders.join(', ') || t('No folders') }}</p>
                <p v-for="target in setup.summary.targets" :key="target.target"><strong>{{ target.target }}</strong><br />{{ target.operations.join(' · ') }}<br />{{ target.authenticated ? t('Uses a private Project connection') : t('No connection credential') }}</p>
                <p v-if="setup.summary.restrictedSenders">{{ t('Restricted to approved senders') }}</p>
              </template>
              <p v-if="setup.source">{{ t('Source: reviewed Agent capability profile') }}</p>
            </template>
            <template v-if="agent && setup?.status !== 'ready'">
              <p>{{ setup?.problem === 'credential_missing' ? t('The Agent creator must complete its private connection before this group can enable it. Never send secrets in chat.') : t('The Agent creator must finish and publish its capability profile for this Bot. Group members do not need to configure permissions.') }}</p>
              <RouterLink :to="{ name: 'chat', params: { projectId, sessionId: '' } }">{{ setup?.problem === 'credential_missing' ? t('Open private connection setup') : t('Open Agent configuration') }}</RouterLink>
            </template>
            <button class="btn btn-sm" :disabled="busy || !agent || setup?.status !== 'ready' || group.pending">{{ t('Review group setup') }}</button>
          </form>
          <RouterLink v-if="!agents.length" :to="{ name: 'chat', params: { projectId, sessionId: '' } }">{{ t('Open Agent configuration') }}</RouterLink>
          <p>{{ t('Choose an Agent, review its published capabilities, then approve. No access is enabled before approval.') }}</p>
          <details><summary>{{ t('Group details') }}</summary><small>{{ group.botName }} · {{ group.botInstanceId }}<br />{{ group.conversationId }}</small><p>{{ t('Discovery is not authorization. Received text is shown here without running an Agent. At most 20 messages per group are kept for 7 days; attachments are not downloaded and old messages are not backfilled.') }}</p></details>
        </div></ComposerPopover>
      </header>
      <div v-if="proposalError" class="proposal-error" role="alert"><span>{{ proposalErrorText }} <small v-if="diagnostic">{{ diagnostic }}</small> <small>({{ proposalStatus || t('Network error') }} · {{ proposalError }})</small></span><button class="btn btn-sm" @click="refresh(); reviewVersion++">{{ t('Refresh') }}</button><button v-if="proposalError === 'existing_publication_review'" class="btn btn-sm" @click="existingReviewOpen = true">{{ t('Open review') }}</button><RouterLink v-if="proposalError.startsWith('group_setup_')" :to="{ name: 'chat', params: { projectId, sessionId: '' } }">{{ t('Open Agent configuration') }}</RouterLink></div>
      <details v-if="group.pending" class="group-review" :open="reviewOpen" @toggle="reviewOpen = ($event.target as HTMLDetailsElement).open"><summary><span class="i-lucide-message-circle-question" aria-hidden="true" />{{ t('Group setup awaiting review') }}<span>{{ t('Review permissions') }}</span></summary>
      <PublicationRequest :key="reviewVersion" :api-base="apiBase" :project-id="projectId" session-id="owner:service-groups" :active="active" :can-submit="active" :conversation="group" />
      </details>
      <details v-if="existingReviewOpen" class="group-review" open><summary>{{ t('Existing publication review') }}</summary><PublicationRequest :api-base="apiBase" :project-id="projectId" session-id="owner:service-groups" :active="active" :can-submit="active" :conversation="group" /></details>
      <section v-if="discoveryOnly" class="observed-messages" :aria-label="t('Received messages')">
        <p v-if="!group.messages.length" class="empty-observation">{{ t('Waiting for new messages') }}</p>
        <template v-for="(message, index) in group.messages" :key="message.id">
          <div v-if="index === 0 || day(message.receivedAt) !== day(group.messages[index - 1]!.receivedAt)" class="message-day">{{ day(message.receivedAt) }}</div>
          <article class="observed-message-row"><div class="sender-avatar" aria-hidden="true"><span class="i-lucide-user-round" /></div><div class="message-body"><header><strong :title="message.sender">{{ senderName(message.sender) }}</strong><MessageTimestamp :timestamp="new Date(message.receivedAt).toISOString()" /></header><p class="observed-message">{{ message.text }}</p></div></article>
        </template>
      </section>
    </template>
    <p v-else-if="!error && discoveryOnly">{{ t('No observed group at this address. The platform may not have delivered events, or the observation has expired. No history is backfilled.') }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import UiSelect from './UiSelect.vue'
import ComposerPopover from './ComposerPopover.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import PublicationRequest from './PublicationRequest.vue'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { useServiceGroups, serviceGroupKey, groupDisplayName } from '../service-groups.ts'
const props = defineProps<{ apiBase: string; projectId: string; groupKey?: string; sessionId?: string; active: boolean; discoveryOnly?: boolean }>()
const { groups, agents, agentSetups, revision, error, refresh } = useServiceGroups(() => ({ ...props, group: props.groupKey, session: props.sessionId }))
const group = computed(() => groups.value.find(group => (props.groupKey ? serviceGroupKey(group) === props.groupKey : group.sessionId === props.sessionId)))
const diagnostic = ref('')
const setup = computed(() => agentSetups.value.find(setup => setup.agent === agent.value && setup.botInstanceId === group.value?.botInstanceId))
const agent = ref(''), busy = ref(false), proposalError = ref(''), proposalStatus = ref(0), reviewOpen = ref(false), existingReviewOpen = ref(false), reviewVersion = ref(0)
watch(agent, () => { diagnostic.value = '' })
let controller: AbortController | undefined
watch(() => [props.projectId, props.groupKey, props.sessionId], () => { controller?.abort(); controller = undefined; busy.value = false; proposalError.value = ''; reviewOpen.value = false; existingReviewOpen.value = false; agent.value = ''; diagnostic.value = ''; reviewVersion.value++ })
watch(() => group.value?.agent, value => { if (value && !agent.value) agent.value = value })
onUnmounted(() => controller?.abort())
async function propose() {
  if (busy.value || !group.value || (!agent.value || setup.value?.status !== 'ready') || group.value.pending) return
  const current = controller = new AbortController()
  const target = group.value
  busy.value = true; proposalError.value = ''; diagnostic.value = ''; proposalStatus.value = 0
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/service-groups/propose'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([current.signal, AbortSignal.timeout(30000)]), body: JSON.stringify({ botInstanceId: target.botInstanceId, conversationId: target.conversationId, agent: agent.value, revision: revision.value }) })
    if (!response.ok) { const body = await response.json().catch(() => ({})); proposalStatus.value = response.status; diagnostic.value = body.diagnostic && typeof body.diagnostic === 'object' ? [body.diagnostic.stage, body.diagnostic.tool, body.diagnostic.grant].filter(value => typeof value === 'string').join(' · ') : ''; throw new Error(typeof body.error === 'string' ? body.error : 'group_proposal_failed') }
    if (current !== controller || current.signal.aborted) return
    reviewOpen.value = true; reviewVersion.value++; await refresh()
  } catch (error) { if (controller === current && !current.signal.aborted) proposalError.value = proposalStatus.value ? (error instanceof Error ? error.message : 'group_proposal_failed') : 'network_error' }
  finally { if (controller === current) { controller = undefined; busy.value = false } }
}
function day(time: number) { return new Date(time).toLocaleDateString() }
function senderName(sender: string) { return /^(?:[a-z_-]+:)?[0-9a-f_-]{12,}$/i.test(sender) || sender.length > 24 ? t('Member · {suffix}', { suffix: sender.slice(-6) }) : sender || t('Group member') }
const proposalMessages = {
  draft_or_publication_changed: 'Setup changed. Refresh and try again.', stale_request: 'Setup changed. Refresh and try again.',
  unrelated_authoring_draft: 'Setup changed. Refresh and try again.', existing_publication_review: 'A review is already open. Finish it before creating another.',
  agent_name_taken: 'This Agent name is already in use.', agent_not_published: 'This Agent is no longer published. Refresh and select again.',
  unsafe_agent_prompt: 'Remove sensitive content from the prompt.', invalid_group_proposal: 'Check the Agent name and prompt.',
  group_setup_profile_missing: 'The Agent creator must finish and publish its capability profile for this Bot. Group members do not need to configure permissions.',
  group_setup_skill_missing: 'Select a published skill providing the required tool. No access was enabled.',
  group_setup_grant_missing: 'The selected skill requires an explicit capability grant. Configure its scope and review before enabling.',
  group_setup_validation_failed: 'The setup could not pass live validation. Check its Bot and permissions.',
  group_setup_credential_missing: 'A configured credential is missing. Check the setup permissions.',
  group_setup_folder_missing: 'A configured folder is unavailable. Check the setup permissions.',
  group_setup_inbox_invalid: 'A configured message target is invalid. Check the setup permissions.',
  group_setup_legacy_discord: 'Resolve legacy Discord bindings before publishing.',
  publication_in_progress: 'Publication is in progress. Refresh shortly.', stopped: 'Reviews are temporarily unavailable. Try again shortly.',
  group_not_observed: 'This group observation expired. Refresh to check again.', service_bot_not_found: 'This Bot was removed. Refresh the group list.',
} as const
const proposalErrorText = computed(() => t(proposalMessages[proposalError.value as keyof typeof proposalMessages] || 'Could not prepare setup. Refresh and retry; no access was enabled.'))
</script>
<style scoped>
.channel-group-context { min-width: 0; color: var(--c-text); font-size: 13px; }
.group-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 0; min-width: 0; }
.group-toolbar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.group-toolbar :deep(.composer-control) { margin-left: auto; flex-shrink: 0; }
.group-status, small { color: var(--c-text-secondary); font-size: 12px; }
.group-status { white-space: nowrap; }
.group-setup { padding: 12px; font-size: 13px; color: var(--c-text); overflow-wrap: anywhere; }
.group-setup form, .group-setup label { display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
.group-setup form { padding: 10px 0; } .group-setup input, .group-setup textarea { width: 100%; min-width: 0; box-sizing: border-box; }
.group-setup p { color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; }
summary { cursor: pointer; } .group-setup details { padding: 8px 0; }
.group-review { margin: 8px 0 16px; border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 12px; }
.group-review > summary { color: var(--c-text); font-size: 12px; } .group-review > summary span:last-child { color: var(--c-text-secondary); margin-left: 10px; }
.proposal-error { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px; overflow-wrap: anywhere; }
.observed-messages { padding: 10px 0 24px; } .message-day { text-align: center; color: var(--c-text-secondary); font-size: 11px; margin: 16px 0; }
.observed-message-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 4px; }
.sender-avatar { width: 30px; height: 30px; border-radius: 50%; background: var(--c-bg-muted); display: grid; place-items: center; color: var(--c-text-secondary); flex-shrink: 0; }
.message-body { min-width: 0; flex: 1; } .message-body header { display: flex; align-items: center; gap: 10px; } .message-body strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.observed-message { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; line-height: 1.7; }
.empty-observation { color: var(--c-text-secondary); text-align: center; padding: 40px 16px; }
@media (max-width: 600px) { .group-toolbar { gap: 6px; } .group-status { font-size: 11px; } .observed-message-row { gap: 8px; } }
</style>
