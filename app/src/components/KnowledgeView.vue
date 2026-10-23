<template>
  <div ref="scroll" class="knowledge-scroll">
  <section class="knowledge" :class="{ 'sidebar-layout': !!sidebarTarget }" :aria-label="t('Project knowledge')">
    <header class="heading">
      <div v-if="!selectedId"><h1>{{ t('Knowledge') }}</h1><p>{{ t('Memory, wiki and skills for this project. References are explicit links, not inferred relationships.') }}</p></div>
      <div v-else class="page-location"><button type="button" @click="emit('home')">{{ t('Knowledge') }}</button><span aria-hidden="true">/</span><span>{{ title(selectedId) }}</span></div>
      <div class="heading-actions">
        <button type="button" :aria-label="t('Back')" :title="t('Back (Alt+Left)')" @click="router.back()">{{ t('Back') }}</button>
        <button type="button" :aria-label="t('Forward')" :title="t('Forward (Alt+Right)')" @click="router.forward()">{{ t('Forward') }}</button>
        <button v-if="!selectedId" type="button" :aria-pressed="showGraph" @click="showGraph = !showGraph">{{ t('Relationship graph') }}</button>
        <button type="button" :disabled="loading || !!deletion" @click="refresh">{{ t('Refresh') }}</button>
      </div>
    </header>
    <template>
      <KnowledgeMaintenance v-show="!selectedId" :api-base="apiBase" :project-id="projectId" :revision="maintenanceRevision" :active="active"
        @select="select" @changed="refresh" />
      <p v-if="loading" role="status">{{ t('Loading knowledge...') }}</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="workspace">
        <Teleport :to="sidebarTarget || 'body'" :disabled="!sidebarTarget">
          <aside class="knowledge-navigation" :aria-label="t('Knowledge entries')">
            <div class="navigation-controls">
              <div class="filters" :aria-label="t('Knowledge categories')">
                <button v-for="tab in tabs" :key="tab.kind" type="button" :aria-pressed="kind === tab.kind" @click="kind = tab.kind">
                  {{ tab.label }} <span>{{ count(tab.kind) }}</span>
                </button>
              </div>
              <input v-model="query" type="search" :aria-label="t('Search knowledge')" :placeholder="t('Search knowledge')" />
              <p class="muted">{{ filtered.length }} / {{ catalog.entries.length }} {{ t('entries') }}</p>
            </div>
            <div class="entries">
              <p v-if="!loading && !filtered.length" class="muted">{{ catalog.entries.length ? t('No matching entries.') : t('No knowledge entries yet.') }}</p>
              <button v-for="item in filtered" :key="item.id" type="button" class="entry" :aria-pressed="selectedId === item.id" @click="select(item.id)">
                <strong>{{ item.title }}</strong><span>{{ enumLabel(item.kind) }} · {{ item.source === 'builtin' ? t('Built-in / read-only') : t('Project') }}</span><small>{{ item.path }}</small>
              </button>
            </div>
          </aside>
        </Teleport>
        <main class="content">
          <template v-if="showGraph && !selectedId">
            <label class="focus-filter"><input v-model="focusGraph" type="checkbox" :disabled="!selectedId" /> {{ t('Focus on selected entry and its direct references') }}</label>
            <KnowledgeGraph :catalog="catalog" :visible-ids="graphIds" :selected-id="selectedId" @select="select" />
            <p class="muted graph-hint">{{ t('Filtered graphs also include direct neighbors from other categories. Dashed nodes are outside the catalog, not necessarily missing files. Use Link health to verify them.') }}</p>
          </template>
          <section v-if="selectedId" class="detail" :aria-busy="detailLoading" :aria-label="t('Knowledge entry details')">
            <p v-if="detailLoading" role="status">{{ t('Loading entry...') }}</p>
            <p v-if="detailError" role="alert" class="error">{{ detailError }} <button type="button" @click="loadDetail">{{ t('Retry') }}</button></p>
            <template v-if="detail">
              <div class="detail-heading">
                <div><h2>{{ detail.entry.title }}</h2><code>{{ detail.entry.path }}</code></div>
                <button v-if="detail.entry.deletable" type="button" class="danger" :disabled="loading || !!error || detailLoading" @click="deletion = detail.entry">{{ t('Delete') }}</button>
                <span v-else class="muted">{{ t('Built-in / read-only') }}</span>
              </div>
              <p v-if="detail.entry.description">{{ detail.entry.description }}</p>
              <div class="preview-controls">
                <button type="button" :aria-pressed="raw" @click="raw = !raw">{{ raw ? t('Show preview') : t('Show source') }}</button>
                <span class="muted">{{ t('Follow links in the preview or use References below.') }}</span>
              </div>
              <p v-if="linkError" role="alert" class="error">{{ linkError }}</p>
              <pre v-if="raw || detail.entry.path.endsWith('.jsonl')" class="source">{{ detail.content }}</pre>
              <div v-else ref="previewElement" class="prose max-w-none knowledge-preview" @click="followPreviewLink" v-html="preview" />
            </template>
            <template v-else-if="!detailLoading && !detailError">
              <h2>{{ t('Unresolved reference') }}</h2><code>{{ selectedId }}</code>
              <p>{{ t('This target is not in the current knowledge catalog. It may have been deleted or may not be a browsable knowledge entry.') }}</p>
            </template>
            <div class="relations">
              <section><h3>{{ t('Referenced by (') }}{{ relations.incoming.length }})</h3>
                <p v-if="!relations.incoming.length" class="muted">{{ t('No incoming references.') }}</p>
                <button v-for="(link, index) in relations.incoming" :key="index" type="button" @click="select(link.source)">{{ title(link.source) }} <small>{{ link.label }}</small></button>
              </section>
              <section><h3>{{ t('References (') }}{{ relations.outgoing.length }})</h3>
                <p v-if="!relations.outgoing.length" class="muted">{{ t('No outgoing references.') }}</p>
                <button v-for="(link, index) in relations.outgoing" :key="index" type="button" :class="{ error: !entriesById.has(link.target) }" @click="select(link.target)">
                  {{ title(link.target) }} <small>{{ entriesById.has(link.target) ? link.label : t('Unresolved · {label}', { label: link.label }) }}</small>
                </button>
              </section>
            </div>
          </section>
          <p v-else class="empty">{{ t('Select an entry to read its content and references.') }}</p>
        </main>
      </div>
      <KnowledgeDeleteDialog v-if="deletion" :api-base="apiBase" :project-id="projectId" :target="deletion"
        :incoming="knowledgeRelations(catalog, deletion.id).incoming" @close="deletion = undefined" @deleted="deleted" />
    </template>
  </section>
  </div>
</template>

<script setup lang="ts">
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createKnowledgeClient, filterKnowledge, knowledgeRelations, type KnowledgeCatalog, type KnowledgeDetail, type KnowledgeEntry, type KnowledgeKind } from '../knowledge.ts'
import { renderKnowledgeMarkdown } from '../knowledge-markdown.ts'
import KnowledgeGraph from './KnowledgeGraph.vue'
import KnowledgeDeleteDialog from './KnowledgeDeleteDialog.vue'
import KnowledgeMaintenance from './KnowledgeMaintenance.vue'

const props = withDefaults(defineProps<{ apiBase: string; projectId: string; entryId?: string; active?: boolean; sidebarTarget?: string }>(), { active: true })
const emit = defineEmits<{ select: [id: string]; home: []; catalog: [entries: KnowledgeEntry[]] }>()
const router = useRouter()
const route = useRoute()
const selectedId = ref(props.entryId ?? '')
const scroll = ref<HTMLDivElement>()
const previewElement = ref<HTMLDivElement>()
const linkError = ref('')
let pendingAnchor: { id: string; fragment: string } | undefined
const scrollPositions = new Map<string, number>()
const catalog = ref<KnowledgeCatalog>({ entries: [], links: [] })
const detail = ref<KnowledgeDetail>()
const deletion = ref<KnowledgeEntry>()
const kind = ref<KnowledgeKind | 'all'>('all')
const query = ref('')
const showGraph = ref(true)
const focusGraph = ref(false)
const raw = ref(false)
const loading = ref(false)
const detailLoading = ref(false)
const error = ref('')
const detailError = ref('')
const notice = ref('')
const maintenanceRevision = ref(0)
let catalogRequest: AbortController | undefined
let detailRequest: AbortController | undefined
const detailCache = new Map<string, KnowledgeDetail>()
function restoreScroll(id: string) {
  void nextTick(() => {
    if (selectedId.value !== id || !scroll.value) return
    if (pendingAnchor?.id === id) {
      if (detail.value?.entry.id !== id || !previewElement.value) return
      const fragment = pendingAnchor.fragment
      pendingAnchor = undefined
      let name: string
      try { name = decodeURIComponent(fragment) }
      catch (cause) {
        if (!(cause instanceof URIError)) throw cause
        linkError.value = t('This link has an invalid section address.')
        return
      }
      const target = [...previewElement.value.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === name)
      if (target) {
        target.scrollIntoView({ block: 'start' })
        target.tabIndex = -1
        target.focus({ preventScroll: true })
      } else if (!fragment) previewElement.value.scrollTop = 0
      else linkError.value = t('Section "#{name}" was not found in this entry.', { name: name })
      return
    }
    scroll.value.scrollTop = scrollPositions.get(id) ?? 0
  })
}
const tabs = [
  { kind: 'all', get label() { return t('All') } }, { kind: 'memory', get label() { return t('Memory') } },
  { kind: 'wiki', get label() { return t('Wiki') } }, { kind: 'skill', get label() { return t('Skills') } },
] as const
const entriesById = computed(() => new Map(catalog.value.entries.map(item => [item.id, item])))
const filtered = computed(() => filterKnowledge(catalog.value, kind.value, query.value))
const graphIds = computed(() => focusGraph.value && selectedId.value ? [selectedId.value] : filtered.value.map(item => item.id))
const relations = computed(() => knowledgeRelations(catalog.value, selectedId.value))
const preview = computed(() => renderKnowledgeMarkdown(detail.value?.content ?? '', relations.value.outgoing,
  (id, fragment) => router.resolve({
    name: 'chat', params: { projectId: props.projectId },
    query: { panel: 'knowledge', entry: id }, hash: fragment ? `#${fragment}` : '',
  }).href))
const title = (id: string) => entriesById.value.get(id)?.title ?? id
const count = (category: KnowledgeKind | 'all') => category === 'all' ? catalog.value.entries.length : catalog.value.entries.filter(item => item.kind === category).length
function select(id: string) { selectedId.value = id; emit('select', id) }

function followPreviewLink(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor || !previewElement.value?.contains(anchor)) return
  const { knowledgeId, knowledgeFragment, knowledgeError } = anchor.dataset
  if (knowledgeId === undefined && knowledgeFragment === undefined && knowledgeError === undefined) return
  event.preventDefault()
  linkError.value = ''
  if (knowledgeError !== undefined) {
    linkError.value = t('Cannot open "{knowledgeError}" from this preview. Refresh Knowledge or use Link health to check the reference.', { knowledgeError: knowledgeError })
    return
  }
  const id = knowledgeId ?? selectedId.value
  pendingAnchor = knowledgeFragment ? { id, fragment: knowledgeFragment } : undefined
  if (!knowledgeId) pendingAnchor = { id, fragment: knowledgeFragment ?? '' }
  if (id !== selectedId.value) select(id)
  else restoreScroll(id)
}

async function loadDetail() {
  detailRequest?.abort()
  detail.value = detailCache.get(selectedId.value)
  detailError.value = ''
  detailLoading.value = false
  if (!props.active || !selectedId.value || !entriesById.value.has(selectedId.value)) return
  if (detail.value) return
  const request = new AbortController()
  detailRequest = request
  detailLoading.value = true
  try {
    const result = await createKnowledgeClient(props.apiBase).read(selectedId.value, request.signal)
    if (!request.signal.aborted) { detailCache.set(result.entry.id, result); detail.value = result }
  } catch (cause) {
    if (!request.signal.aborted) detailError.value = cause instanceof Error ? cause.message : t('Could not load this entry.')
  } finally { if (!request.signal.aborted) detailLoading.value = false }
}
async function refresh() {
  catalogRequest?.abort()
  detailRequest?.abort()
  detailCache.clear()
  detail.value = undefined
  detailLoading.value = false
  detailError.value = ''
  loading.value = false
  const request = new AbortController()
  catalogRequest = request
  if (!props.active) return
  loading.value = true
  error.value = ''
  try {
    const result = await createKnowledgeClient(props.apiBase).list(request.signal)
    if (request.signal.aborted) return
    catalog.value = result
    emit('catalog', result.entries)
    await loadDetail()
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load knowledge.')
  } finally { if (!request.signal.aborted) loading.value = false }
}
async function deleted(id: string) {
  deletion.value = undefined
  detail.value = undefined
  detailRequest?.abort()
  detailCache.delete(id)
  catalog.value = {
    entries: catalog.value.entries.filter(item => item.id !== id),
    links: catalog.value.links.filter(link => link.source !== id),
  }
  notice.value = t('File deleted. Other entries and their references were kept.')
  maintenanceRevision.value++
  await refresh()
}
watch(selectedId, (id, previous) => {
  if (scroll.value) scrollPositions.set(previous, scroll.value.scrollTop)
  notice.value = ''
  linkError.value = ''
  if (pendingAnchor?.id !== id) pendingAnchor = undefined
  void loadDetail()
  restoreScroll(id)
})
watch(detail, () => restoreScroll(selectedId.value), { flush: 'post' })
watch(() => props.entryId, id => { selectedId.value = id ?? '' })
watch(() => [props.apiBase, props.active] as const, ([base, active], previous) => {
  deletion.value = undefined
  if (base !== previous?.[0]) {
    detailCache.clear()
    scrollPositions.clear()
    catalog.value = { entries: [], links: [] }
    query.value = ''
    notice.value = ''
    linkError.value = ''
    pendingAnchor = undefined
  }
  if (active) void refresh()
  else {
    catalogRequest?.abort()
    detailRequest?.abort()
    loading.value = false
    detailLoading.value = false
  }
}, { immediate: true })
watch(() => [props.entryId, route.query.entry, route.hash] as const, ([id, entry, hash]) => {
  if (id && entry === id && hash) {
    pendingAnchor = { id, fragment: hash.slice(1) }
    raw.value = false
    restoreScroll(id)
  }
}, { immediate: true })
onUnmounted(() => { catalogRequest?.abort(); detailRequest?.abort() })
</script>

<style scoped>
.knowledge-scroll { flex: 1; min-height: 0; min-width: 0; width: 100%; overflow: auto; }
.knowledge { width: 100%; max-width: 1600px; box-sizing: border-box; padding: 20px; margin: 0 auto; color: var(--c-text); }
.heading, .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.heading-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.page-location { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; color: var(--c-text-secondary); font-size: 13px; }
.page-location button { border: 0; padding: 4px 0; color: var(--c-blue); background: transparent; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 18px; margin: 0 0 6px; }
h3 { font-size: 13px; font-weight: 600; }
.heading p, .muted, small { color: var(--c-text-secondary); font-size: 12px; }
button, input[type=search] { border: 1px solid var(--c-border); border-radius: var(--radius-control); padding: 8px 12px; background: var(--c-bg-card); color: inherit; font: inherit; font-size: 13px; }
button { cursor: pointer; }
button:hover, button[aria-pressed=true] { background: var(--c-bg-muted); border-color: var(--c-blue); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: .5; }
.knowledge-navigation { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; color: var(--c-text); }
.navigation-controls { padding: 12px 8px 4px; border-bottom: 1px solid var(--c-border); }
.filters { display: flex; flex-wrap: wrap; gap: 4px; }
.filters button { padding: 6px; }
.filters span { color: var(--c-text-muted); margin-left: 4px; }
input[type=search] { display: block; box-sizing: border-box; width: 100%; margin: 10px 0; }
.workspace { display: grid; grid-template-columns: minmax(200px, 270px) minmax(0, 1fr); gap: 20px; }
.sidebar-layout .workspace { display: block; }
.workspace > .knowledge-navigation { height: auto; }
.entries { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.workspace > .knowledge-navigation .entries { max-height: 78vh; }
.entry { display: grid; gap: 6px; width: 100%; margin-bottom: 6px; text-align: left; overflow-wrap: anywhere; }
.entry span { font-size: 11px; color: var(--c-text-secondary); }
.content { min-width: 0; }
.focus-filter { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; }
.graph-hint { margin: 8px 0 20px; }
.detail { padding: 18px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); overflow-wrap: anywhere; }
code { font-size: 12px; overflow-wrap: anywhere; }
.preview-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 16px 0; }
.source { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; max-height: 60vh; overflow: auto; }
.knowledge-preview { max-height: 60vh; overflow: auto; }
.knowledge-preview :deep(pre) { white-space: pre-wrap; }
.knowledge-preview :deep(a[href]:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.relations { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; border-top: 1px solid var(--c-border); margin-top: 20px; }
.relations section { min-width: 0; }
.relations button { display: grid; gap: 4px; width: 100%; margin-bottom: 6px; text-align: left; overflow-wrap: anywhere; }
.error, .danger { color: var(--c-error); }
.empty { padding: 32px; text-align: center; color: var(--c-text-muted); }
@media (max-width: 800px) { .workspace { grid-template-columns: 1fr; } .entries { max-height: 260px; } .relations { grid-template-columns: 1fr; gap: 0; } }
</style>
