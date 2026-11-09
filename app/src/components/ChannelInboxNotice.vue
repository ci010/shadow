<template>
  <section class="channel-inbox-notice" :aria-label="t('Passive channel inbox')">
    <strong>{{ t('Passive channel inbox') }}</strong>
    <p>{{ t('Received messages are stored here without invoking an Agent, tools or replies. Only messages delivered by the platform can be recorded. Attachments are metadata references, not downloaded files.') }}</p>
    <dl><dt>{{ t('Platform') }}</dt><dd>{{ source.platform }}</dd><dt>{{ t('Connection') }}</dt><dd>{{ source.botInstanceId }}</dd><dt>{{ t('Channel source') }}</dt><dd>{{ source.kind }} · {{ source.conversationId }}<span v-if="source.parentId"> · {{ source.parentId }}</span></dd></dl>
    <p>{{ t('In an owner Web chat, type @ and select this inbox to assign a BOT. The reference identifies the target, not permission. BOT files and exact deployment approval still control execution. Old inbox history is never replayed automatically; unassigning stops inference, not receipt.') }}</p>
    <RouterLink :to="{ name: 'chat', params: { projectId: source.projectId } }">{{ t('Open owner chat') }}</RouterLink>
  </section>
</template>
<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '../i18n.ts'
import type { ChannelSource } from '../../../src/channels/passive-contract.ts'
defineProps<{ source: ChannelSource }>()
</script>
<style scoped>
.channel-inbox-notice { margin: 8px 0; padding: 12px; border: 1px solid var(--c-border); background: var(--c-bg-soft); font-size: 13px; overflow-wrap: anywhere; }
p, dl { color: var(--c-text-secondary); line-height: 1.6; max-width: 70ch; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; }
dd { margin: 0; }
a { display: inline-flex; align-items: center; min-height: 36px; color: var(--c-primary); text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { a { min-height: 44px; } }
</style>
