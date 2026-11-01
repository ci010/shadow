<template>
  <section class="channels-view" :aria-label="t('Bots')">
    <header><h2>{{ t('Bots') }}</h2><p>{{ t('Choose a platform connection first. BOT behavior and permissions are configured in files through conversation.') }}</p></header>
    <p v-if="requestedReviewId" class="review-notice" role="status">{{ t('This link belongs to the retired Discord configuration workflow. No change has been approved or published. Return to chat to inspect the current BOT files and request a new exact deployment confirmation.') }}</p>
    <BotConnectionSetup :key="projectId" :api-base="apiBase" :project-id="projectId" :available="available" :active="active" />
    <details v-if="available" class="deployment-inventory">
      <summary>{{ t('BOT deployments') }}</summary>
      <BotPackage v-if="available" :key="projectId" :api-base="apiBase" :project-id="projectId" :active="active" />
    </details>
  </section>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import BotConnectionSetup from './BotConnectionSetup.vue'
import BotPackage from './BotPackage.vue'
defineProps<{ apiBase: string; projectId: string; available: boolean; active: boolean; reviewBotId?: string; requestedReviewId?: string }>()
</script>
<style scoped>
.channels-view { min-width: 0; }
header { margin-bottom: 20px; }
h2 { margin: 0 0 8px; font-size: 20px; }
p { color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; max-width: 70ch; }
.review-notice { color: var(--c-warn); }
.deployment-inventory { margin-top: 24px; border-top: 1px solid var(--c-border); }
summary { padding-block: 12px; cursor: pointer; font-size: 13px; }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
