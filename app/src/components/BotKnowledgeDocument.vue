<template>
  <article class="bot-document" :aria-label="path">
    <header>
      <h2>{{ bot }} / {{ path }}</h2>
      <p>{{ t('Deployed snapshot / read-only') }}</p>
      <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh">{{ t('Refresh') }}</button>
      <button v-if="content !== undefined" type="button" class="btn btn-sm" :aria-pressed="raw" @click="raw = !raw">{{ raw ? t('Show preview') : t('Show source') }}</button>
    </header>
    <p v-if="loading" role="status">{{ t('Loading entry...') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="active && inventory?.state.value.value && !revision" role="status">{{ t('This deployed Markdown document is unavailable.') }}</p>
    <SystemPromptCard v-if="content !== undefined" :prompt="content" :raw="raw" :show-provenance="false" embedded />
  </article>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n.ts'
import { useKnowledgeResourceStore } from '../stores/knowledge.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import SystemPromptCard from './SystemPromptCard.vue'

const props = defineProps<{ apiBase: string; projectId: string; bot: string; path: string; active: boolean }>()
const owner = useKnowledgeResourceStore(requireResourcePinia()).owner
const enabled = useCatalogVisibility(() => props.active)
const inventory = shallowRef<ReturnType<typeof owner.bots>>()
const document = shallowRef<ReturnType<typeof owner.botDocument>>()
const raw = ref(false)
const revision = computed(() => inventory.value?.state.value.value?.documents.find(bot => bot.id === props.bot && bot.paths.includes(props.path))?.revision)
const loading = computed(() => inventory.value?.state.value.loading || document.value?.state.value.loading)
const error = computed(() => inventory.value?.state.value.error || document.value?.state.value.error)
const content = computed(() => document.value?.state.value.value)
watch(() => [props.apiBase, props.projectId, enabled.value] as const, ([base, project, active], _, cleanup) => {
  inventory.value = undefined
  if (!active) return
  const lease = inventory.value = owner.bots(base, project)
  cleanup(lease.release)
}, { immediate: true })
watch(() => [props.apiBase, props.projectId, props.bot, props.path, revision.value, enabled.value] as const, ([base, project, bot, path, revision, active], _, cleanup) => {
  document.value = undefined
  if (!active || !revision) return
  const lease = document.value = owner.botDocument(base, project, bot, path, revision)
  cleanup(lease.release)
}, { immediate: true })
async function refresh() {
  const previous = document.value
  await inventory.value?.refresh()
  if (previous && previous === document.value) await previous.refresh()
}
</script>

<style scoped>
.bot-document { flex: 1; min-height: 0; overflow: auto; padding: 16px; background: var(--c-bg-card); color: var(--c-text); }
header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--c-border); }
h2 { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
header p { color: var(--c-text-secondary); font-size: 12px; }
button { margin-inline-end: 8px; }
[role='alert'] { color: var(--c-error); }
</style>
