<template>
  <section class="channels-view" :aria-label="section === 'connections' ? t('Connections') : t('Bots')">
    <header>
      <h2>{{ section === 'connections' ? t('Connections') : t('Bots') }}</h2>
      <p>{{ section === 'connections' ? t('Manage platform credentials, connection status and owner pairing here. Multiple BOTs can reuse one service connection without sharing their permissions.') : t('Configure BOT behavior and bindings in chat using BOT.md and bot.json in the registered source folder. This page only shows deployment status; it does not maintain a second binding configuration.') }}</p>
      <RouterLink class="chat-entry" :to="{ name: 'chat', params: { projectId } }">{{ t('Configure BOTs in chat') }}</RouterLink>
      <p>{{ t('In chat, describe the BOT and source folder to configure. Review the exact content and permissions before deployment. For credentials, an authorized owner Web chat can open a private connection card; never paste secrets into chat or ordinary ask replies. QQ and Discord chats cannot open this private card.') }}</p>
      <RouterLink v-if="section === 'bots'" class="related-entry" :to="{ name: 'project-settings', params: { projectId, section: 'connections' } }">{{ t('Manage platform connections') }}</RouterLink>
    </header>
    <p v-if="requestedReviewId" class="review-notice" role="status">{{ t('This link belongs to the retired Discord configuration workflow. No change has been approved or published. Return to chat to inspect the current BOT files and request a new exact deployment confirmation.') }}</p>
    <BotConnectionSetup v-if="section === 'connections'" :key="projectId" :api-base="apiBase" :project-id="projectId" :available="available" :active="active" />
    <section v-else-if="available" class="deployment-inventory">
      <BotPackage v-if="available" :key="projectId" :api-base="apiBase" :project-id="projectId" :active="active" />
    </section>
  </section>
</template>
<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '../i18n.ts'
import BotConnectionSetup from './BotConnectionSetup.vue'
import BotPackage from './BotPackage.vue'
withDefaults(defineProps<{ apiBase: string; projectId: string; available: boolean; active: boolean; section?: 'bots' | 'connections'; reviewBotId?: string; requestedReviewId?: string }>(), { section: 'bots' })
</script>
<style scoped>
.channels-view { min-width: 0; }
header { margin-bottom: 20px; }
h2 { margin: 0 0 8px; font-size: 20px; }
p { color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; max-width: 70ch; }
.review-notice { color: var(--c-warn); }
.deployment-inventory { margin-top: 24px; border-top: 1px solid var(--c-border); }
a { display: inline-flex; align-items: center; min-height: 36px; color: var(--c-primary); font-size: 13px; text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { a { min-height: 44px; } }
</style>
