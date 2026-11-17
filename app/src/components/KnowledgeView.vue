<template>
  <div ref="scroll" class="knowledge-scroll">
  <section class="knowledge" :class="{ 'sidebar-layout': !!sidebarTarget || sharedExplorer, 'canvas-layout': !selectedId }" :aria-label="t('Project knowledge')">
    <header v-if="selectedId" class="heading">
      <button type="button" @click="emit('home')">{{ t('Knowledge') }}</button>
      <div class="heading-actions">
        <HoverInfo :text="t('Back (Alt+Left)')" v-slot="{ triggerProps }"><button v-bind="triggerProps" type="button" @click="router.back()">{{ t('Back') }}</button></HoverInfo>
        <HoverInfo :text="t('Forward (Alt+Right)')" v-slot="{ triggerProps }"><button v-bind="triggerProps" type="button" @click="router.forward()">{{ t('Forward') }}</button></HoverInfo>
        <button type="button" :disabled="loading || !!deletion" @click="refresh">{{ t('Refresh') }}</button>
      </div>
    </header>
      <aside v-if="showMaintenance && !selectedId" class="maintenance-overlay" :aria-label="t('Link health')">
        <button type="button" @click="showMaintenance = false">{{ t('Close') }}</button>
        <KnowledgeMaintenance :api-base="apiBase" :project-id="projectId" :revision="maintenanceRevision" :active="active" @select="select" @changed="refresh" />
      </aside>
      <p v-if="loading" role="status">{{ t('Loading knowledge...') }}</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="workspace">
        <Teleport v-if="!sharedExplorer" :to="sidebarTarget || 'body'" :disabled="!sidebarTarget">
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
          <KnowledgeGraph v-if="!selectedId" :catalog="catalog" :visible-ids="graphIds" :selected-id="graphSelection" @select="graphSelection = $event" @open="select">
            <template #tools>
              <HoverInfo :text="t('Search knowledge')" v-slot="{ triggerProps }"><details class="canvas-menu" :name="menuName" @keydown.esc.stop.prevent="closeMenu">
                <summary v-bind="triggerProps" :aria-label="t('Search knowledge')"><span class="i-lucide-search" aria-hidden="true" /><span v-if="query || kind !== 'all' || focusGraph" class="filter-dot" /></summary>
                <div class="canvas-popover">
                  <input v-model="query" type="search" :aria-label="t('Search knowledge')" :placeholder="t('Search knowledge')" />
                  <div class="filters" :aria-label="t('Knowledge categories')">
                    <button v-for="tab in tabs" :key="tab.kind" type="button" :aria-pressed="kind === tab.kind" @click="kind = tab.kind">{{ tab.label }} <span>{{ count(tab.kind) }}</span></button>
                  </div>
                  <label class="focus-filter"><input v-model="focusGraph" type="checkbox" :disabled="!graphSelection" /> {{ t('Focus on selected entry and its direct references') }}</label>
                </div>
              </details></HoverInfo>
              <HoverInfo :text="t('More information')" v-slot="{ triggerProps }"><details class="canvas-menu" :name="menuName" @keydown.esc.stop.prevent="closeMenu">
                <summary v-bind="triggerProps" :aria-label="t('More information')"><span class="i-lucide-ellipsis" aria-hidden="true" /></summary>
                <div class="canvas-popover">
                  <div class="heading-actions"><button type="button" @click="router.back()">{{ t('Back') }}</button><button type="button" @click="router.forward()">{{ t('Forward') }}</button><button type="button" :disabled="loading || !!deletion" @click="refresh">{{ t('Refresh') }}</button></div>
                  <button type="button" :aria-expanded="showMaintenance" @click="showMaintenance = !showMaintenance">{{ t('Link health') }}</button>
                  <p>{{ t('Memory, wiki and skills for this project. References are explicit links, not inferred relationships.') }}</p>
                  <p>{{ t('Filtered graphs also include direct neighbors from other categories. Dashed nodes are outside the catalog, not necessarily missing files. Use Link health to verify them.') }}</p>
                </div>
              </details></HoverInfo>
            </template>
          </KnowledgeGraph>
          <p v-if="excludedSelection" role="status">{{ t('Not a knowledge document.') }}</p>
          <section v-else-if="selectedId" class="detail" :aria-busy="detailLoading" :aria-label="t('Knowledge entry details')">
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
              </div>
              <p v-if="linkError" role="alert" class="error">{{ linkError }}</p>
              <KnowledgeEvents v-if="!raw && /^memory\/events\/[^/]+\.jsonl$/.test(detail.entry.path)" :content="detail.content" :links="relations.outgoing" @select="select" />
              <pre v-else-if="raw || detail.entry.path.endsWith('.jsonl')" class="source">{{ detail.content }}</pre>
              <div v-else ref="previewElement" class="prose max-w-none knowledge-preview" @click="followPreviewLink" v-markdown-link-hints v-html="preview" />
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

        </main>
      </div>
      <KnowledgeDeleteDialog v-if="deletion" :api-base="apiBase" :project-id="projectId" :target="deletion"
        :incoming="knowledgeRelations(catalog, deletion.id).incoming" @close="deletion = undefined" @deleted="deleted" />
  </section>
  </div>
</template>

<script setup lang="ts">
import { vMarkdownLinkHints } from '../markdown-link-hints'
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isFileHistory, isKnowledgeDocument, visibleKnowledgeCatalog, filterKnowledge, knowledgeRelations, type KnowledgeCatalog, type KnowledgeDetail, type KnowledgeEntry, type KnowledgeKind } from '../knowledge.ts'
import { renderKnowledgeMarkdown } from '../knowledge-markdown.ts'
import { useKnowledgeResourceStore } from '../stores/knowledge.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import KnowledgeGraph from './KnowledgeGraph.vue'
import HoverInfo from './HoverInfo.vue'
import KnowledgeEvents from './KnowledgeEvents.vue'
import KnowledgeDeleteDialog from './KnowledgeDeleteDialog.vue'
import KnowledgeMaintenance from './KnowledgeMaintenance.vue'

const props = withDefaults(defineProps<{ apiBase: string; projectId: string; entryId?: string; active?: boolean; sidebarTarget?: string; sharedExplorer?: boolean }>(), { active: true })
const emit = defineEmits<{ select: [id: string]; home: []; catalog: [entries: KnowledgeEntry[]] }>()
const router = useRouter()
const route = useRoute()
const selectedId = ref(props.entryId ?? '')
const scroll = ref<HTMLDivElement>()
const previewElement = ref<HTMLDivElement>()
const linkError = ref('')
let pendingAnchor: { id: string; fragment: string } | undefined
const scrollPositions = new Map<string, number>()
const owner = useKnowledgeResourceStore(requireResourcePinia()).owner
const enabled = useCatalogVisibility(() => props.active)
const catalogLease = shallowRef<ReturnType<typeof owner.catalog>>()
const detailLease = shallowRef<ReturnType<typeof owner.detail>>()
const catalog = computed<KnowledgeCatalog>(() => visibleKnowledgeCatalog(catalogLease.value?.state.value.value ?? { entries: [], links: [] }))
const excludedSelection = computed(() => isFileHistory(selectedId.value)
  || !!catalogLease.value?.state.value.value?.entries.some(entry => entry.id === selectedId.value && !isKnowledgeDocument(entry))
  || !!(detailLease.value?.state.value.value && !isKnowledgeDocument(detailLease.value.state.value.value.entry)))
const detail = computed<KnowledgeDetail | undefined>(() => excludedSelection.value ? undefined : detailLease.value?.state.value.value)
const deletion = ref<KnowledgeEntry>()
const kind = ref<KnowledgeKind | 'all'>('all')
const query = ref('')
const menuName = `knowledge-tools-${useId()}`
function closeMenu(event: KeyboardEvent) {
  const menu = event.currentTarget as HTMLDetailsElement
  menu.open = false
  menu.querySelector('summary')?.focus()
}
const focusGraph = ref(false)
const graphSelection = ref('')
const showMaintenance = ref(false)
const raw = ref(false)
const loading = computed(() => catalogLease.value?.state.value.loading ?? false)
const detailLoading = computed(() => detailLease.value?.state.value.loading ?? false)
const error = computed(() => catalogLease.value?.state.value.error ?? '')
const detailError = computed(() => detailLease.value?.state.value.error ?? '')
const notice = ref('')
const maintenanceRevision = ref(0)
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
const graphIds = computed(() => focusGraph.value && graphSelection.value ? [graphSelection.value] : filtered.value.map(item => item.id))
const relations = computed(() => knowledgeRelations(catalog.value, selectedId.value))
const preview = computed(() => renderKnowledgeMarkdown(detail.value?.content ?? '', relations.value.outgoing,
  (id, fragment) => router.resolve({
    name: 'chat', params: { projectId: props.projectId },
    query: { panel: 'knowledge', entry: id }, hash: fragment ? `#${fragment}` : '',
  }).href))
const title = (id: string) => entriesById.value.get(id)?.title ?? id
const count = (category: KnowledgeKind | 'all') => category === 'all' ? catalog.value.entries.length : catalog.value.entries.filter(item => item.kind === category).length
// Each workbench document has a fixed identity. Navigation opens/activates a
// sibling tab; mutating this view would leave home/A displaying B on return.
function select(id: string) { emit('select', id) }

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
  if (id !== selectedId.value) {
    // A section deep link is one route transaction. Activating first would
    // race the group's route projection and discard the destination fragment.
    if (knowledgeFragment && props.sharedExplorer) void router.push({ name: 'chat', params: { ...route.params, projectId: props.projectId },
      query: { ...route.query, panel: 'knowledge', entry: id }, hash: `#${knowledgeFragment}` })
    else select(id)
  } else restoreScroll(id)
}

async function refresh() {
  await catalogLease.value?.refresh()
  await detailLease.value?.refresh()
}
async function loadDetail() { await detailLease.value?.refresh() }
async function deleted(id: string) {
  deletion.value = undefined
  catalogLease.value?.removeEntry(id)
  notice.value = t('File deleted. Other entries and their references were kept.')
  maintenanceRevision.value++
  await refresh()
}
watch(() => [props.apiBase, props.projectId, enabled.value] as const, ([base, projectId, active], previous, cleanup) => {
  deletion.value = undefined
  catalogLease.value = undefined
  if (base !== previous?.[0] || projectId !== previous?.[1]) {
    scrollPositions.clear()
    query.value = ''
    notice.value = ''
    linkError.value = ''
    pendingAnchor = undefined
  }
  if (!active) return
  const lease = owner.catalog(base, projectId)
  catalogLease.value = lease
  cleanup(lease.release)
}, { immediate: true })
watch(() => catalog.value, value => {
  // Releasing a hidden document's lease is not an empty catalog update.
  if (enabled.value && catalogLease.value?.state.value.value) emit('catalog', value.entries)
})
watch(() => [props.apiBase, props.projectId, enabled.value, selectedId.value, entriesById.value.get(selectedId.value)?.revision] as const,
  ([base, projectId, active, id, revision], _, cleanup) => {
    detailLease.value = undefined
    if (!active || !id || isFileHistory(id) || revision === undefined) return
    const lease = owner.detail(base, projectId, id, revision)
    detailLease.value = lease
    cleanup(lease.release)
  }, { immediate: true })
watch(selectedId, (id, previous) => {
  if (scroll.value) scrollPositions.set(previous, scroll.value.scrollTop)
  notice.value = ''
  linkError.value = ''
  if (pendingAnchor?.id !== id) pendingAnchor = undefined
  restoreScroll(id)
})
watch(detail, () => restoreScroll(selectedId.value), { flush: 'post' })
watch(() => props.entryId, id => { selectedId.value = id ?? '' })
watch(() => [props.entryId, route.query.entry, route.hash] as const, ([id, entry, hash]) => {
  if (id && entry === id && hash) {
    pendingAnchor = { id, fragment: hash.slice(1) }
    raw.value = false
    restoreScroll(id)
  }
}, { immediate: true })
</script>

<style scoped>
.knowledge-scroll { flex: 1; min-height: 0; min-width: 0; width: 100%; overflow: auto; }
.knowledge { width: 100%; min-height: 100%; box-sizing: border-box; padding: 12px; color: var(--c-text); }
.knowledge-scroll:has(.canvas-layout) { overflow: hidden; }
.canvas-layout { height: 100%; padding: 0; display: flex; flex-direction: column; position: relative; }
.canvas-layout .workspace { flex: 1; min-height: 0; gap: 0; }
.canvas-layout.sidebar-layout .workspace { display: flex; }
.canvas-layout .content { flex: 1; height: 100%; min-height: 0; }
.canvas-layout > p { position: absolute; z-index: 3; top: 60px; left: 12px; right: 12px; padding: 8px; background: var(--c-bg-card); }
.canvas-menu { position: static; }
.canvas-menu summary { list-style: none; display: flex; align-items: center; justify-content: center; position: relative; min-width: 32px; min-height: 32px; cursor: pointer; }
.canvas-menu summary::-webkit-details-marker { display: none; }
.canvas-menu summary:hover, .canvas-menu[open] summary { background: var(--c-bg-muted); }
.canvas-menu summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.canvas-popover { position: absolute; left: 0; top: calc(100% + 6px); width: min(340px, calc(100cqw - 24px)); box-sizing: border-box; max-height: min(420px, 60cqh); overflow: auto; padding: 12px; background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); font-size: 12px; }
.canvas-menu[open] { z-index: 4; }
.canvas-popover .heading-actions { justify-content: flex-start; margin-bottom: 8px; }
.canvas-popover p { line-height: 1.6; color: var(--c-text-secondary); }
.canvas-popover .focus-filter { margin: 12px 0 0; }
.filter-dot { position: absolute; right: 4px; top: 4px; width: 5px; height: 5px; background: var(--c-primary); }
.canvas-layout { container-type: size; }
@media (max-width: 700px), (pointer: coarse) { .canvas-menu summary { min-height: 44px; min-width: 44px; } }
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
.maintenance-overlay { position: absolute; z-index: 5; top: 72px; right: 12px; bottom: 12px; width: min(520px, calc(100% - 24px)); box-sizing: border-box; overflow: auto; padding: 12px; background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.heading { position: sticky; top: 0; z-index: 1; align-items: center; padding: 4px; background: var(--c-bg-card); box-shadow: 0 4px 16px var(--c-shadow-soft); margin-bottom: 16px; }
.detail { max-width: 80ch; margin: 0 auto; padding: 18px; background: var(--c-bg-card); overflow-wrap: anywhere; }
@media (max-width: 700px) { .heading { gap: 4px; } .heading-actions { gap: 2px; } .heading button { padding: 6px; min-height: 44px; } .detail { padding: 12px; } }
code { font-size: 12px; overflow-wrap: anywhere; }
.preview-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 16px 0; }
.source { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
.knowledge-preview { min-width: 0; }
.knowledge-preview :deep(pre) { white-space: pre-wrap; }
.knowledge-preview :deep(a[href]:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.relations { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; border-top: 1px solid var(--c-border); margin-top: 20px; }
.relations section { min-width: 0; }
.relations button { display: grid; gap: 4px; width: 100%; margin-bottom: 6px; text-align: left; overflow-wrap: anywhere; }
.error, .danger { color: var(--c-error); }
.empty { padding: 32px; text-align: center; color: var(--c-text-muted); }
@media (max-width: 800px) { .workspace { grid-template-columns: 1fr; } .entries { max-height: 260px; } .relations { grid-template-columns: 1fr; gap: 0; } }
</style>
