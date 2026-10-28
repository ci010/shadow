<template>
  <section class="channel-group-context" :aria-label="t('Service group')">
    <p v-if="error" role="alert">{{ t('Could not load service groups. Retry.') }} <button class="btn btn-sm" @click="refresh">{{ t('Retry') }}</button></p>
    <template v-if="group">
      <header class="group-toolbar">
        <strong v-if="discoveryOnly" :title="group.conversationId">{{ groupDisplayName(group) }}</strong>
        <span class="group-status" :title="group.enabled ? t('Enabled — ordinary received messages do not trigger a reply unless the Bot trigger policy allows it.') : t('Not enabled — received messages do not trigger an Agent or a reply.')">{{ t('Quietly observing') }}</span>
        <ComposerPopover :key="group.botInstanceId + group.conversationId" :label="t('Group Agent setup')" :width="380"><template #trigger><span class="i-lucide-settings-2" aria-hidden="true" /><span>{{ t('Settings') }}</span></template><div class="group-setup">
          <p>{{ t('Edit BOT.md, bot.json and tool modules in a registered local Folder, then ask your Agent to deploy. One confirmation shows the summary and permission changes. Workspace edits never change a running deployment.') }}</p>
          <RouterLink :to="{ name: 'chat', params: { projectId, sessionId: '' } }">{{ t('Open Agent configuration') }}</RouterLink>
          <details><summary>{{ t('Group details') }}</summary><small>{{ group.botName }} · {{ group.botInstanceId }}<br />{{ group.conversationId }}</small><p>{{ t('Discovery is not authorization. Received text is shown here without running an Agent. At most 20 messages per group are kept for 7 days; attachments are not downloaded and old messages are not backfilled.') }}</p></details>
        </div></ComposerPopover>
      </header>
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
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import ComposerPopover from './ComposerPopover.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import { t } from '../i18n.ts'
import { useServiceGroups, serviceGroupKey, groupDisplayName } from '../service-groups.ts'
const props = defineProps<{ apiBase: string; projectId: string; groupKey?: string; sessionId?: string; active: boolean; discoveryOnly?: boolean }>()
const {groups,error,refresh}=useServiceGroups(()=>({...props,group:props.groupKey,session:props.sessionId}))
const group=computed(()=>groups.value.find(group=>props.groupKey ? serviceGroupKey(group)===props.groupKey : group.sessionId===props.sessionId))
function day(time: number) { return new Date(time).toLocaleDateString() }
function senderName(sender: string) { return /^(?:[a-z_-]+:)?[0-9a-f_-]{12,}$/i.test(sender) || sender.length > 24 ? t('Member · {suffix}', { suffix: sender.slice(-6) }) : sender || t('Group member') }
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
