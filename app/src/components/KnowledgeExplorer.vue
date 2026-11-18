<template>
  <aside :id="explorerId" class="knowledge-explorer-pane" :aria-label="t('Knowledge explorer')" @keydown.esc.stop.prevent="$emit('close')">
    <header><strong>{{ t('Knowledge') }}</strong><HoverInfo :text="t('Refresh')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Refresh')" :disabled="loading" @click="refresh"><span class="i-lucide-refresh-cw" aria-hidden="true" /></button></HoverInfo></header>
    <input v-model="query" type="search" :aria-label="t('Search knowledge')" :placeholder="t('Search knowledge')" />
    <p v-if="loading" role="status">{{ t('Loading knowledge...') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="definitionError" role="alert">{{ definitionError }}</p>
    <p v-if="bots?.state.value.value?.partial" role="status">{{ t('Some Bot documents are unavailable. Check Bot settings.') }}</p>
    <p v-if="!loading && noMatches">{{ t('No matching entries.') }}</p>
    <nav :aria-label="t('Knowledge entries')"><KnowledgeTree :key="query" :nodes="tree" :selected-id="selectedId" @select="$emit('select', $event)" /></nav>
  </aside>
</template>
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n.ts'
import { filterKnowledge } from '../knowledge.ts'
import { definitionTree, knowledgeTree } from '../knowledge-tree.ts'
import { useKnowledgeResourceStore } from '../stores/knowledge.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import KnowledgeTree from './KnowledgeTree.vue'
import HoverInfo from './HoverInfo.vue'
const props = defineProps<{ apiBase: string; projectId: string; active: boolean; explorerId: string; selectedId?: string }>()
defineEmits<{ select: [id: string]; close: [] }>()
const owner = useKnowledgeResourceStore(requireResourcePinia()).owner
const enabled = useCatalogVisibility(() => props.active)
const lease = shallowRef<ReturnType<typeof owner.catalog>>()
const agents = shallowRef<ReturnType<typeof owner.agents>>()
const bots = shallowRef<ReturnType<typeof owner.bots>>()
const query = ref('')
const catalog = computed(() => lease.value?.state.value.value ?? { entries: [], links: [] })
const entries = computed(() => filterKnowledge(catalog.value, 'all', query.value))
const tree = computed(() => [...knowledgeTree(entries.value), ...definitionTree(agents.value?.state.value.value ?? [], bots.value?.state.value.value?.documents ?? [], query.value)])
const noMatches = computed(() => !tree.value.some(root => root.children.length))
const loading = computed(() => lease.value?.state.value.loading || agents.value?.state.value.loading || bots.value?.state.value.loading)
const definitionError = computed(() => agents.value?.state.value.error || bots.value?.state.value.error)
function refresh() { void lease.value?.refresh(); void agents.value?.refresh(); void bots.value?.refresh() }
const error = computed(() => lease.value?.state.value.error)
watch(() => [props.apiBase, props.projectId, enabled.value] as const, ([base, project, active], previous, cleanup) => {
  lease.value = agents.value = bots.value = undefined
  if (base !== previous?.[0] || project !== previous?.[1]) query.value = ''
  if (!active) return
  const next = owner.catalog(base, project)
  lease.value = next
  const nextAgents = agents.value = owner.agents(base, project)
  const nextBots = bots.value = owner.bots(base, project)
  cleanup(() => { next.release(); nextAgents.release(); nextBots.release() })
}, { immediate: true })
</script>
<style scoped>
.knowledge-explorer-pane { display: flex; flex-direction: column; width: 240px; flex: 0 0 240px; min-width: 0; min-height: 0; border-right: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); }
header { display: flex; align-items: center; justify-content: space-between; padding: 8px; font-size: 13px; }
header button { display: grid; place-items: center; width: 32px; height: 32px; border: 0; background: transparent; color: inherit; }
header span { width: 16px; height: 16px; }
input { margin: 0 8px 8px; min-width: 0; padding: 6px; border: 1px solid var(--c-control-border); background: var(--c-bg-input); color: inherit; }
nav { overflow: auto; flex: 1; min-height: 0; padding: 0 8px; }
p { padding: 0 8px; font-size: 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px), (pointer: coarse) { header button, input { min-height: 44px; } }
</style>
