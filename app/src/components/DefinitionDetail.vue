<template>
  <article ref="scroller" class="definition-detail" :aria-labelledby="`${id}-heading`">
    <header class="agent-heading">
      <slot name="before-heading" />
      <h2 :id="`${id}-heading`" ref="heading" tabindex="-1">{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
      <slot name="heading-actions" />
    </header>
    <div ref="tablist" class="agent-tabs" role="tablist" :aria-label="label">
      <button v-for="(tab, index) in tabs" :id="`${id}-${tab.id}-tab`" :key="tab.id" type="button" role="tab"
        :aria-controls="`${id}-${tab.id}-panel`" :aria-selected="activeTab === tab.id" :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id" @keydown="tabKeydown($event, index)">
        {{ tab.label }}<span v-if="tab.id === 'tools' && inspection && !inspection.copyDisabled" class="tab-count">{{ inspection.tools.length }}</span>
      </button>
    </div>
    <div class="agent-content">
      <section v-for="tab in tabs" v-show="activeTab === tab.id" :id="`${id}-${tab.id}-panel`" :key="tab.id"
        :class="tab.id === 'overview' ? 'agent-overview' : undefined" role="tabpanel" :aria-labelledby="`${id}-${tab.id}-tab`" :aria-busy="isInspection(tab.id) && busy" tabindex="0">
        <slot v-if="activeTab === tab.id" name="status" />
        <slot v-if="tab.id === 'overview'" name="overview" />
        <template v-else-if="activeTab === tab.id">
          <template v-if="tab.id === 'definition'">
            <template v-if="source !== undefined">
              <div class="prompt-format">
                <button type="button" :aria-pressed="sourceRaw" @click="sourceRaw = !sourceRaw">{{ sourceRaw ? t('Show preview') : t('Show source') }}</button>
              </div>
              <SystemPromptCard :prompt="source" :raw="sourceRaw" :show-provenance="false" embedded />
            </template>
            <slot v-else name="source-empty" />
          </template>
          <template v-else>
            <div v-if="$slots['inspection-selector'] || inspection" class="preview-toolbar">
              <slot name="inspection-selector" />
              <div v-if="tab.id === 'prompt' && inspection" class="prompt-format" role="group" :aria-label="t('System prompt format')">
                <button type="button" :aria-pressed="!rawPrompt" @click="rawPrompt = false">{{ t('Read') }}</button>
                <button type="button" :aria-pressed="rawPrompt" @click="rawPrompt = true">{{ t('Raw') }}</button>
              </div>
              <button v-if="inspection" type="button" class="preview-copy" :disabled="copyBusy || busy || inspection.copyDisabled || !canCopy" @click="copy">
                <span :class="copied ? 'i-lucide-check' : 'i-lucide-copy'" aria-hidden="true" />{{ copied ? t('Copied') : tab.id === 'tools' ? t('Copy JSON') : t('Copy prompt') }}
              </button>
            </div>
            <slot name="inspection-status" />
            <p v-if="copyError" class="agent-error" role="alert">{{ copyError }}</p>
            <p v-if="copied" class="copy-feedback" role="status">{{ tab.id === 'tools' ? t('Tools JSON copied.') : t('System prompt copied.') }}</p>
            <template v-if="inspection">
              <template v-if="tab.id === 'tools'">
                <label class="agent-search tool-search"><span class="i-lucide-search" aria-hidden="true" /><input v-model="toolQuery" type="search" :aria-label="t('Search tools')" :placeholder="t('Search tools')" autocomplete="off" /></label>
                <ToolsCard :key="inspection.key" :tools="filteredTools" embedded :empty-message="toolQuery.trim() ? t('No matching tools.') : t('No tools available.')" />
              </template>
              <template v-else>
                <p v-if="inspection.prompt" class="prompt-estimate">{{ t('Approx.') }} {{ formatNumber(Math.round(inspection.prompt.length / 4)) }} {{ t('tokens') }}</p>
                <SystemPromptCard :key="inspection.key" :prompt="inspection.prompt" :sections="inspection.sections" embedded :raw="rawPrompt" empty-message="No system prompt." />
              </template>
            </template>
            <slot name="inspection-footer" />
          </template>
        </template>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { t, formatNumber } from '../i18n.ts'
import { useTextCopy } from '../composables/useTextCopy.ts'
import type { PromptSection } from '../prompt-sections.ts'
import ToolsCard, { type ToolDef } from './ToolsCard.vue'
import SystemPromptCard from './SystemPromptCard.vue'

type View = 'overview' | 'tools' | 'prompt' | 'definition'
const props = defineProps<{
  title: string; description?: string; label: string
  tabs: readonly { id: View; label: string }[]
  source?: string; sourceInitiallyRaw?: boolean; busy?: boolean
  inspectionIdentity?: string; retainPromptFormat?: boolean
  inspection?: { key: string; tools: ToolDef[]; prompt: string; sections?: PromptSection[]; copyDisabled?: boolean }
}>()
const activeTab = defineModel<View>({ required: true })
const id = `definition-${useId()}`
const scroller = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const tablist = ref<HTMLElement>()
const sourceRaw = ref(!!props.sourceInitiallyRaw)
const rawPrompt = ref(false)
const toolQuery = ref('')
const isInspection = (tab: View) => tab === 'tools' || tab === 'prompt'
const filteredTools = computed(() => {
  const query = toolQuery.value.trim().toLowerCase()
  return (props.inspection?.tools ?? []).filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query))
})
const canCopy = computed(() => activeTab.value === 'tools' ? !!props.inspection?.tools.length : !!props.inspection?.prompt)
const { copied, busy: copyBusy, error: copyError, copy } = useTextCopy(
  () => activeTab.value === 'tools' ? JSON.stringify(props.inspection?.tools ?? [], null, 2) : props.inspection?.prompt ?? '',
  () => [activeTab.value, props.inspectionIdentity, props.inspection, props.busy],
)
watch(() => props.inspectionIdentity, () => { toolQuery.value = ''; if (!props.retainPromptFormat) rawPrompt.value = false })
async function openView(view: View) {
  activeTab.value = view
  await nextTick()
  tablist.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
}
function tabKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const tabs = props.tabs
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  void openView(tabs[next]!.id)
}
function focusHeading() {
  scroller.value?.scrollTo({ top: 0 })
  heading.value?.focus({ preventScroll: true })
}
defineExpose({ openView, focusHeading })
</script>

<style scoped>
.definition-detail { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--c-bg-card); color: var(--c-text); }
.tab-count { color: var(--c-text-muted); font-size: 12px; font-weight: 400; }
.agent-error { color: var(--c-error); font-size: 13px; overflow-wrap: anywhere; }
.prompt-estimate { margin: 12px 0; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.prompt-format { margin-bottom: 12px; }
.preview-toolbar .prompt-format { margin-bottom: 0; }
.preview-copy > span { width: 14px; height: 14px; flex-shrink: 0; }
button:focus-visible, [role="tabpanel"]:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.agent-search { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--c-control-border); background: var(--c-bg-input); padding: 0 8px; }
.agent-search > span { flex: 0 0 14px; width: 14px; height: 14px; color: var(--c-text-muted); }
.agent-search input { width: 100%; min-width: 0; min-height: 32px; padding: 6px 0; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; outline: none; }
.agent-search:focus-within { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.agent-search input::placeholder { color: var(--c-text-muted); }
.agent-heading { padding: 24px 28px 20px; }
.agent-heading h2 { margin: 0; font-size: clamp(19px, 2vw, 26px); line-height: 1.4; font-weight: 500; letter-spacing: -.025em; overflow-wrap: anywhere; }
.agent-heading h2:focus { outline: none; }
.agent-heading p { max-width: 72ch; margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-tabs { flex-wrap: wrap; position: sticky; top: 0; z-index: 1; display: flex; gap: 20px; margin: 0 28px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.agent-tabs > button:where(:not(.ui-select)) { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.agent-tabs > button:where(:not(.ui-select))[aria-selected="true"] { border-bottom-color: var(--c-blue); color: var(--c-text); }
.agent-content { min-width: 0; padding: 24px 28px 32px; }
:deep(.detail-scope) { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; font-size: 12px; color: var(--c-text-secondary); }
:deep(.detail-scope .ui-select) { min-width: min(110px, 100%); max-width: 100%; min-height: 32px; }
.preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 24px; }
.preview-copy, .prompt-format button:where(:not(.ui-select)) { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; padding: 6px 10px; border: 1px solid var(--c-border); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.preview-copy { margin-inline-start: auto; }
.preview-copy:disabled { opacity: .5; cursor: default; }
.prompt-format { display: flex; }
.prompt-format button:where(:not(.ui-select)) + button:where(:not(.ui-select)) { border-inline-start: 0; }
.prompt-format button:where(:not(.ui-select))[aria-pressed="true"] { background: var(--c-bg-muted); }
.tool-search { max-width: 360px; margin-bottom: 24px; }
.copy-feedback { font-size: 12px; color: var(--c-success); }
:deep(.detail-overview-section) { max-width: 72ch; }
:deep(.detail-overview-section + .detail-overview-section) { margin-top: 32px; }
:deep(.detail-overview-section h3) { margin: 0 0 16px; font-size: 14px; line-height: 20px; font-weight: 600; }
:deep(.detail-facts) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 24px; margin: 0; }
:deep(.detail-facts dt) { margin-bottom: 6px; font-size: 12px; line-height: 20px; color: var(--c-text-muted); }
:deep(.detail-facts dd) { margin: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
@container agent-browser (max-width: 700px) {
  :deep(.detail-scope) { flex-basis: 100%; justify-content: space-between; }
  :deep(.detail-facts) { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .agent-heading { padding: 20px 16px; }
  .agent-tabs { gap: 4px 16px; margin-inline: 16px; }
  .agent-content { padding: 20px 16px 28px; }
  .agent-tabs > button, .preview-copy, .prompt-format button, :deep(.detail-scope .ui-select) { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
@media (pointer: coarse) {
  .agent-tabs > button, .preview-copy, .prompt-format button, :deep(.detail-scope .ui-select) { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
</style>
