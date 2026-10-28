<script setup lang="ts">
import './alignment-controls.css'
import { computed, defineAsyncComponent, reactive, ref, type Component } from 'vue'
import { t, setLocalePreference } from '../../i18n.ts'
import AlignmentIntentInspector from './AlignmentIntentInspector.vue'
import { parseAlignmentTarget, type AlignmentLabDocument, type AlignmentSource, type AlignmentTarget, type AlignmentViewKind } from '../../alignment-lab-model.ts'

const kinds: AlignmentViewKind[] = ['timeline', 'storyboard', 'graph', 'spatial']
type Tab = 'image' | AlignmentViewKind
const tabs = computed(() => [
  { id: 'image' as Tab, label: t('Image regions'), subtitle: t('Where in the picture?') },
  { id: 'storyboard' as Tab, label: t('Edit workspace'), subtitle: t('Storyboard · Video · Audio') },
  { id: 'graph' as Tab, label: t('Graph'), subtitle: t('Which relationship or dependency?') },
  { id: 'spatial' as Tab, label: t('3D space'), subtitle: t('Which surface and viewpoint?') },
])
const requested = new URL(window.location.href).searchParams.get('view')
const active = ref<Tab>(requested === 'image' || kinds.includes(requested as AlignmentViewKind) ? (requested === 'timeline' ? 'storyboard' : requested) as Tab : 'image')
const opened = ref<Tab[]>([active.value])
const views: Record<Tab, Component> = {
  image: defineAsyncComponent(() => import('./ImageAlignmentLab.vue')),
  timeline: defineAsyncComponent(() => import('./TimelineAlignmentSurface.vue')),
  storyboard: defineAsyncComponent(() => import('./EditorAlignmentSurface.vue')),
  graph: defineAsyncComponent(() => import('./GraphAlignmentSurface.vue')),
  spatial: defineAsyncComponent(() => import('./SpatialAlignmentSurface.vue')),
}
function empty(kind: AlignmentViewKind, source: AlignmentSource = { id: '', label: '', revision: '', context: '' }): AlignmentLabDocument {
  return { schema: 'shadow.alignment/v1', kind, source, description: '', constraints: '', annotations: [] }
}
const drafts = reactive(Object.fromEntries(kinds.map(kind => [kind, empty(kind)])) as Record<AlignmentViewKind, AlignmentLabDocument>)
const selected = reactive<Partial<Record<AlignmentViewKind, string>>>({})
const targets = computed(() => Object.fromEntries(kinds.map(kind => [kind, drafts[kind].annotations.map(annotation => annotation.target)])) as Record<AlignmentViewKind, AlignmentTarget[]>)
const error = ref('')
function activate(tab: Tab) {
  active.value = tab
  if (!opened.value.includes(tab)) opened.value.push(tab)
  const url = new URL(window.location.href); url.searchParams.set('view', tab); window.history.replaceState(null, '', url)
  error.value = ''
}
function tabKey(event: KeyboardEvent, tab: Tab) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const list = tabs.value.map(item => item.id), index = list.indexOf(tab)
  const next = event.key === 'Home' ? list[0]! : event.key === 'End' ? list.at(-1)! : list[(index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]!
  activate(next)
  document.getElementById(`tab-${next}`)?.focus()
}
function source(kind: AlignmentViewKind, value: AlignmentSource) {
  // Surfaces confirm before replacement. Version changes never silently reuse old coordinates.
  drafts[kind] = empty(kind, value)
  selected[kind] = undefined
  error.value = ''
}
function target(kind: AlignmentViewKind, value: AlignmentTarget) {
  try {
    if (!drafts[kind].source.id) return
    const anchor = parseAlignmentTarget(value)
    const previous = drafts[kind].annotations.find(annotation => annotation.target.id === anchor.id)
    if (!previous && drafts[kind].annotations.length >= 100) { error.value = t('Use at most 100 anchored instructions per view.'); return }
    if (previous) previous.target = anchor
    else drafts[kind].annotations.push({ target: anchor, intent: 'change', description:
      anchor.selector.type === 'sequence' && anchor.selector.proposedOrder ? t('Use this proposed shot order.')
        : anchor.selector.type === 'graph' && anchor.selector.proposedConnection ? t('Add this proposed connection.') : '' })
    selected[kind] = anchor.id
  } catch { error.value = t('This selection could not be anchored to the source. Select it again.') }
}
function remove(kind: AlignmentViewKind, id: string) {
  drafts[kind].annotations = drafts[kind].annotations.filter(annotation => annotation.target.id !== id)
  if (selected[kind] === id) selected[kind] = undefined
}
function clear(kind: AlignmentViewKind) {
  if (!window.confirm(t('Clear the instructions for this view? The source stays unchanged.'))) return
  drafts[kind] = empty(kind, drafts[kind].source)
  selected[kind] = undefined
}
</script>

<template>
  <main class="alignment-workbench">
    <header class="lab-header"><div><span class="lab-eyebrow">SHADOW · USER ALIGNMENT</span><h1>{{ t('Alignment Lab') }}</h1><p>{{ t('Locate intent in time, space and relationships. These views describe changes; they do not pretend to execute them.') }}</p></div><div class="lab-languages"><button class="btn" @click="setLocalePreference('zh-CN')">中文</button><button class="btn" @click="setLocalePreference('en')">English</button></div></header>
    <p class="lab-boundary">{{ t('Local experiment: no uploads, no agent calls. Copy a prepared request into chat and attach any source files when you are ready.') }}</p>
    <nav class="lab-tabs" role="tablist" :aria-label="t('Alignment views')"><button v-for="tab in tabs" :id="`tab-${tab.id}`" :key="tab.id" role="tab" :aria-selected="active === tab.id" :aria-controls="`view-${tab.id}`" :data-view="tab.id" :tabindex="active === tab.id ? 0 : -1" @keydown="tabKey($event, tab.id)" @click="activate(tab.id)"><strong>{{ tab.label }}</strong><span>{{ tab.subtitle }}</span></button></nav>
    <p v-if="error" role="alert" class="lab-error">{{ error }}</p>
    <section v-for="kind in opened" v-show="active === kind" :id="`view-${kind}`" :key="kind" role="tabpanel" :aria-labelledby="`tab-${kind}`" class="lab-view" :class="{ 'image-view': kind === 'image', 'editor-view': kind === 'storyboard' }">
      <component v-if="kind === 'image'" :is="views.image" :embedded="true" />
      <template v-else>
        <div class="lab-surface"><component :is="views[kind]" :targets="targets[kind]" :selected-id="selected[kind]" :active="active === kind" :has-instructions="!!(drafts[kind].description.trim() || drafts[kind].constraints.trim() || drafts[kind].annotations.length)" @source="source(kind, $event)" @target="target(kind, $event)" @select="selected[kind] = $event" @remove="remove(kind, $event)" /></div>
        <AlignmentIntentInspector v-model="drafts[kind]" :selected-id="selected[kind]" @select="selected[kind] = $event" @remove="remove(kind, $event)" @clear="clear(kind)" />
      </template>
    </section>
    <footer>{{ t('Drafts stay in this browser tab. Export instructions before refreshing. Preserve intent is a request, not an enforced processing mask.') }}</footer>
  </main>
</template>

<style scoped>
.alignment-workbench { height: 100dvh; overflow: auto; padding: 24px; color: var(--c-text); }
.lab-header { display: flex; justify-content: space-between; gap: 24px; align-items: start; max-width: 1560px; margin: 0 auto; }
.lab-eyebrow { font-size: 10px; letter-spacing: .15em; color: var(--c-text-secondary); } h1 { margin: 8px 0; font-size: 28px; }
.lab-header p { max-width: 850px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
.lab-languages { display: flex; gap: 6px; }.lab-boundary { max-width: 1560px; margin: 16px auto; padding: 10px 12px; background: var(--c-bg-muted); border-inline-start: 3px solid var(--c-blue); font-size: 12px; line-height: 1.6; }
.lab-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; max-width: 1560px; margin: 20px auto; }
.lab-tabs button { display: flex; flex-direction: column; align-items: start; gap: 6px; padding: 14px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; text-align: start; }.lab-tabs strong { font-size: 13px; }.lab-tabs span { font-size: 11px; color: var(--c-text-secondary); line-height: 1.5; }
.lab-tabs button[aria-selected="true"] { border-color: var(--c-blue); background: var(--c-bg-muted); box-shadow: inset 0 -2px var(--c-blue); }
.lab-view { max-width: 1560px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 20px; align-items: start; }.lab-view.image-view { display: block; }.lab-surface { min-width: 0; padding: 18px; border: 1px solid var(--c-border); background: var(--c-bg-card); }
.lab-error { max-width: 1560px; margin: 10px auto; color: var(--c-error); } footer { max-width: 1560px; margin: 22px auto; color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media(max-width: 1000px) { .lab-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media(max-width: 760px) { .alignment-workbench { padding: 12px; }.lab-header { flex-wrap: wrap; }.lab-view { grid-template-columns: 1fr; }.lab-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }.lab-surface { padding: 12px; } }
</style>

<style scoped>
.alignment-workbench{padding:14px 20px}.lab-header{align-items:center}.lab-header h1{font-size:20px;margin:4px 0}.lab-header p{display:none}.lab-boundary{padding:6px 10px;margin:10px auto;font-size:11px}.lab-tabs{display:flex;gap:0;margin:10px auto}.lab-tabs button{flex:1;padding:9px 14px;gap:3px}.lab-tabs span{font-size:10px}.editor-view{gap:0;grid-template-columns:minmax(0,1fr) 290px;background:#202225;--c-text:#d4d7dc;--c-text-secondary:#969da7;--c-border:#3b3e44;--c-bg-card:#282a2e;--c-bg-soft:#202226;--c-bg-muted:#343940;--c-blue:#7eb9e1}.editor-view .lab-surface{padding:0;border:0}.editor-view :deep(.intent-inspector){border-left:4px solid #111;padding:14px;position:static;max-height:850px;overflow:auto}.editor-view :deep(.intent-inspector header p){display:none}.editor-view :deep(.intent-inspector h2){font-size:13px}.editor-view :deep(.intent-inspector textarea){font-size:11px}.editor-view :deep(.intent-actions button){font-size:10px}.editor-view :deep(.intent-anchor){max-height:45px}.editor-view :deep(.intent-targets){max-height:110px}.editor-view :deep(.intent-source){font-size:10px}footer{margin:12px auto;font-size:10px}@media(max-width:1000px){.editor-view{grid-template-columns:minmax(0,1fr) 250px}}@media(max-width:760px){.alignment-workbench{padding:8px}.editor-view{grid-template-columns:1fr}.lab-tabs{flex-wrap:wrap}.lab-tabs button{flex:1 0 40%}.editor-view :deep(.intent-inspector){max-height:none;border-left:0;border-top:4px solid #111}}
</style>
<style scoped>.editor-view :deep(.intent-inspector),.editor-view :deep(.intent-inspector h2),.editor-view :deep(.intent-inspector h3),.editor-view :deep(.intent-inspector label),.editor-view :deep(.intent-inspector strong){color:#d4d7dc}.editor-view :deep(.intent-inspector){max-height:780px}.editor-view :deep(.intent-source code){color:#adb8c7}</style>
