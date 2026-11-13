<template>
  <!-- Only actionable availability/execution notices belong above the transcript. -->
  <div v-if="hasNotice" class="automation-context">
    <div v-if="conversation.error.value" class="automation-note" role="alert">
      <p>{{ conversation.error.value }}</p><button class="btn btn-sm" :disabled="conversation.loading.value" @click="conversation.refresh()">{{ t('Retry automation') }}</button>
    </div>
    <div v-if="conversation.historyError.value" class="automation-note" role="alert">
      <p>{{ conversation.historyError.value }}</p><button class="btn btn-sm" :disabled="conversation.loading.value" @click="conversation.retry()">{{ t('Retry history') }}</button>
    </div>
    <p v-if="automation?.notice" class="automation-note" role="status">{{ automation.notice }}</p>
    <p v-if="run?.organizationProblem" class="automation-note" role="alert">{{ run.organizationProblem === 'unfinished' ? t('Organization ended without finishing. Saved patches remain available.') : t('Organization execution failed. Open diagnostics or the trace for details.') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed } from 'vue'
import type { AutomationConversation } from '../composables/useAutomationConversation.ts'

const props = defineProps<{ conversation: AutomationConversation }>()
const automation = computed(() => props.conversation.automation.value)
const run = computed(() => props.conversation.run.value)
const hasNotice = computed(() => props.conversation.error.value || props.conversation.historyError.value || automation.value?.notice || run.value?.organizationProblem)
</script>

<style scoped>
.automation-context { flex: 0 0 auto; max-height: 30%; overflow: auto; padding: 8px 16px; font-size: 13px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.automation-note { margin: 8px 0; }
.automation-note p { margin: 0 0 8px; }
</style>
