<template>
  <ComposerPopover v-if="selection" :label="t('Choose model')" :title="triggerTitle" :disabled="unavailable" :busy="pending" @opened="resetMenu">
    <template #trigger>
      <span class="model-label">{{ selection.inheriting?.value ? conversationDefaults ? t('Default · ') : t('Project · ') : '' }}{{ modelDisplayName(selection.current.value) || (selection.loading.value ? t('Loading models...') : t('Choose model')) }}</span>
      <span v-if="settings" class="model-effort"><span aria-hidden="true">·</span> {{ effortLabel }}</span>
      <span class="model-chevron i-lucide-chevron-down" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div ref="menu" class="model-menu" @keydown="submenuKey">
      <template v-if="page === 'menu'">
        <button ref="modelRow" type="button" class="model-setting-row model-menu-model" @click="openPage('model')" @keydown.right.prevent="openPage('model')">
          <span>{{ t('Model') }}</span><span class="model-menu-value">{{ modelDisplayName(selection.current.value) || t('Choose model') }}</span><span class="model-chevron i-lucide-chevron-right" aria-hidden="true" />
        </button>
        <button ref="effortRow" type="button" class="model-setting-row model-menu-effort" :disabled="settingsDisabled" @click="openPage('effort')" @keydown.right.prevent="openPage('effort')">
          <span>{{ t('Effort') }}</span><span class="model-menu-value">{{ effortLabel }}</span><span class="model-chevron i-lucide-chevron-right" aria-hidden="true" />
        </button>
        <button v-if="settings" ref="contextRow" type="button" class="model-setting-row model-menu-context" :disabled="settingsDisabled" @click="openPage('context')" @keydown.right.prevent="openPage('context')">
          <span>{{ t('Context window') }}</span><span class="model-menu-value">{{ contextLabel }}</span><span class="model-chevron i-lucide-chevron-right" aria-hidden="true" />
        </button>
      </template>
      <template v-else>
      <div class="model-menu-heading">
        <button v-if="settings" type="button" class="model-menu-back" :aria-label="t('Back to model settings')" @click="back">
          <span class="model-chevron i-lucide-chevron-left" aria-hidden="true" /><span>{{ page === 'model' ? t('Model') : page === 'context' ? t('Context window') : t('Effort') }}</span>
        </button>
        <span v-else>{{ t('Model') }}</span><span class="model-scope">{{ page === 'model' ? t('For new turns') : t('This conversation') }}</span>
      </div>
      <template v-if="page === 'model'">
      <input ref="search" v-model="query" class="model-search" type="search" :placeholder="t('Search models...')" :aria-label="t('Search models')" />
      <div class="model-options" role="group" :aria-label="t('Available models')">
        <button v-if="selection.inherited && !query.trim()" class="model-option" :aria-pressed="selection.inheriting?.value" @click="choose('', close)">
          <span class="model-option-copy"><span>{{ conversationDefaults ? t('Follow configured default') : t('Follow project default') }}</span><small>{{ modelDisplayName(selection.inherited.value) }}</small></span>
        </button>
        <button v-for="model in options" :key="model" class="model-option" :aria-pressed="!selection.inheriting?.value && model === selection.current.value" :title="model" @click="choose(model, close)">
          <span class="model-option-copy"><span>{{ modelDisplayName(model) }}</span><small v-if="modelProvider(model)">{{ modelProvider(model) }}</small></span>
          <span v-if="!selection.inheriting?.value && model === selection.current.value" class="model-check i-lucide-check" aria-hidden="true" />
        </button>
        <p v-if="!options.length" class="model-empty">{{ t('No matching models.') }}</p>
      </div>
      </template>
      <div v-else-if="page === 'context'" class="model-options" role="group" :aria-label="t('Context window')">
        <button class="model-option" :aria-pressed="settings?.contextWindow == null" @click="chooseEffort({ contextWindow: null }, close)">{{ t('Follow project default') }} · {{ contextWindowLabel(selection.defaultReasoning?.value.contextWindow) }}</button>
        <button v-for="window in CONTEXT_WINDOWS" :key="window" class="model-option" :aria-pressed="settings?.contextWindow === window" @click="chooseEffort({ contextWindow: window }, close)">{{ window === 1000000 ? '1M' : `${window / 1000}K` }} · {{ t('This conversation') }}</button>
      </div>
      <ReasoningControls v-else-if="settings" :settings="settings" :inherited-settings="selection.defaultReasoning?.value" :conversation-defaults="conversationDefaults" :model="selection.current.value" :disabled="unavailable || !!settingsDisabled" :busy="pending" @change="chooseEffort($event, close)" />
      </template>
      <p v-if="selection.error.value" class="model-error" role="alert">{{ selection.error.value }}</p>
      </div>
    </template>
  </ComposerPopover>
</template>

<script setup lang="ts">
import { CONTEXT_WINDOWS } from '../../../src/agent/llm-config.ts'
import { t } from '../i18n.ts'
import { computed, nextTick, ref } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import ReasoningControls from './ReasoningControls.vue'
import { filterModelOptions, modelDisplayName, modelProvider, useModelSelection } from '../model-selection.ts'
import { contextWindowLabel, currentEffort, effortOptions, type ReasoningSettings } from '../session-settings.ts'

const props = defineProps<{ settings?: ReasoningSettings; settingsDisabled?: boolean; busy?: boolean; conversationDefaults?: boolean }>()
const emit = defineEmits<{ 'change-settings': [patch: ReasoningSettings] }>()
const selection = useModelSelection()
const query = ref('')
const page = ref<'menu' | 'model' | 'effort' | 'context'>(props.settings ? 'menu' : 'model')
const contextRow = ref<HTMLButtonElement>()
const contextLabel = computed(() => `${props.settings?.contextWindow == null ? t("Default · ") : ""}${contextWindowLabel(props.settings?.contextWindow ?? selection?.defaultReasoning?.value.contextWindow)}`)
const menu = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const modelRow = ref<HTMLButtonElement>()
const effortRow = ref<HTMLButtonElement>()
const unavailable = computed(() => !!selection?.disabled.value)
const pending = computed(() => !!props.busy || !!selection?.loading.value)
const effortLabel = computed(() => {
  const choice = currentEffort(props.settings ?? {})
  const inherited = currentEffort(selection?.defaultReasoning?.value ?? {})
  return choice === 'default' && inherited !== 'default'
    ? t('Default · {label}', { label: effortOptions.find(option => option.value === inherited)!.label })
    : effortOptions.find(option => option.value === choice)!.label
})
const triggerTitle = computed(() => `${selection?.current.value || t('Choose model')}${props.settings ? ` · ${effortLabel.value}` : ''}`)
const options = computed(() => filterModelOptions(selection?.options.value ?? [], selection?.current.value ?? '', query.value))
function resetMenu() {
  page.value = props.settings ? 'menu' : 'model'
  query.value = ''
}
async function openPage(next: 'model' | 'effort' | 'context') {
  if (next !== 'model' && props.settingsDisabled) return
  page.value = next
  await nextTick()
  if (next === 'model') search.value?.focus({ preventScroll: true })
  else {
    const target = next === 'context' ? menu.value?.querySelector<HTMLElement>('.model-option[aria-pressed="true"]') : menu.value?.querySelector<HTMLElement>('.effort-option[aria-pressed="true"]')
      ?? menu.value?.querySelector<HTMLElement>('.effort-option:not(:disabled)')
    target?.focus({ preventScroll: true })
  }
}
async function back() {
  const previous = page.value
  page.value = 'menu'
  query.value = ''
  await nextTick()
  const target = previous === 'model' ? modelRow.value : previous === 'context' ? contextRow.value : effortRow.value
  target?.focus({ preventScroll: true })
}
function submenuKey(event: KeyboardEvent) {
  if (!props.settings || page.value === 'menu' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  if (event.key !== 'Escape' && (event.key !== 'ArrowLeft' || event.target instanceof HTMLInputElement)) return
  event.preventDefault()
  event.stopPropagation()
  void back()
}
function choose(model: string, close: () => void) {
  if (unavailable.value || pending.value) return
  close()
  query.value = ''
  void selection?.select(model)
}
function chooseEffort(patch: ReasoningSettings, close: () => void) {
  if (unavailable.value || pending.value || props.settingsDisabled) return
  close()
  emit('change-settings', patch)
}
</script>

<style scoped>
.model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; color: var(--c-text); }
.model-chevron { flex: 0 0 14px; width: 14px; height: 14px; }
.model-effort { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap; }
.model-menu { display: flex; flex-direction: column; min-height: 0; }
.model-setting-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 40px; padding: 9px 10px; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.model-setting-row:hover:not(:disabled) { background: var(--c-bg-muted); }
.model-setting-row:disabled { opacity: .5; cursor: not-allowed; }
.model-menu-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--c-text-secondary); }
.model-menu-back { display: inline-flex; align-items: center; gap: 6px; padding: 3px 0; border: 0; background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.model-menu-back:hover { color: var(--c-blue); }
.model-menu-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 8px 9px 12px; font-size: 13px; font-weight: 600; }
.model-scope { color: var(--c-text-secondary); font-size: 11px; font-weight: 400; }
.model-search { flex-shrink: 0; box-sizing: border-box; width: calc(100% - 8px); margin: 0 4px 8px; padding: 9px 10px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; }
.model-options { overflow-y: auto; min-height: 0; max-height: 280px; }
.model-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px; padding: 9px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; cursor: pointer; }
.model-option:hover { background: var(--c-bg-muted); }
.model-option[aria-pressed="true"] { background: var(--c-selection-bg); color: var(--c-primary); }
.model-option-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; font-size: 13px; overflow-wrap: anywhere; }
.model-option small { color: var(--c-text-secondary); font-size: 11px; }
.model-check { flex-shrink: 0; width: 16px; height: 16px; }
.model-empty, .model-error { padding: 4px 10px; font-size: 12px; color: var(--c-text-secondary); }
.model-error { color: var(--c-error); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px) { .model-label { max-width: 180px; } }
</style>
