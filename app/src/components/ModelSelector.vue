<template>
  <ComposerPopover v-if="selection" :label="t('Choose model')" :title="triggerTitle" :disabled="unavailable" :busy="pending" @opened="resetMenu" @closed="opened = false">
    <template #trigger>
      <span class="model-label">{{ modelDisplayName(selection.current.value) || (selection.loading.value ? t('Loading models...') : t('Choose model')) }}</span>
      <span v-if="settings && effectiveEffortLabel" class="model-effort"><span aria-hidden="true">·</span> {{ effectiveEffortLabel }}</span>
      <span v-if="providerLabel" class="model-account">{{ providerLabel }}</span>
      <span class="model-chevron i-lucide-chevron-down" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div ref="menu" class="model-menu" @keydown="submenuKey">
      <template v-if="page === 'menu'">
        <div v-if="usage || deepSeekRates || (usageKind === 'copilot-credits' && usageUnavailable)" class="model-usage-row" :class="{ 'model-usage-deepseek': deepSeekRates }">
          <template v-if="usage?.kind === 'copilot-credits'">
            <span>{{ t('{used} / {allowance} AI credits', { used: formatNumber(usage.used), allowance: formatNumber(usage.allowance) }) }}</span>
            <progress aria-hidden="true" :value="usage.used" :max="usage.allowance" />
          </template>
          <span v-else-if="usageKind === 'copilot-credits' && usageUnavailable">{{ t('AI credit allowance unavailable') }}</span>
          <span v-else-if="usage?.kind === 'deepseek-balance'">{{ usage.balances.map(({ total, currency }) => t('API balance: {amount} {currency}', { amount: total, currency })).join(' · ') }}</span>
          <span v-if="deepSeekRates">{{ t('DeepSeek API reference (off-peak, USD / 1M tokens): input {input} · cached {cached} · output {output}', { input: formatNumber(deepSeekRates[0]), cached: formatNumber(deepSeekRates[1]), output: formatNumber(deepSeekRates[2]) }) }}</span>
        </div>
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
        <span v-else>{{ t('Model') }}</span><span class="model-scope">{{ page === 'model' ? t(futureRuns ? 'For future runs' : 'For new turns') : t('This conversation') }}</span>
      </div>
      <template v-if="page === 'model'">
      <input ref="search" v-model="query" class="model-search" type="search" :placeholder="t('Search models...')" :aria-label="t('Search models')" />
      <div v-if="providerFilters.length" class="model-provider-filters" role="group" :aria-label="t('Filter by provider')">
        <button type="button" class="model-provider-tag" :aria-pressed="!activeProvider" @click="activeProvider = ''">{{ t('All') }}</button>
        <button v-for="provider in providerFilters" :key="provider.id" type="button" class="model-provider-tag" :aria-pressed="activeProvider === provider.id" @click="activeProvider = provider.id">{{ provider.label }} <span class="model-provider-count">{{ provider.count }}</span></button>
      </div>
      <div v-if="pageCount > 1" class="model-pagination">
        <button type="button" class="model-provider-tag" :disabled="resultPage === 0" @click="changeResultPage(-1)">{{ t('Previous models') }}</button>
        <span role="status">{{ t('{start}–{end} of {total} models', { start: resultPage * MODELS_PER_PAGE + 1, end: resultPage * MODELS_PER_PAGE + visibleOptions.length, total: options.length }) }}</span>
        <button type="button" class="model-provider-tag" :disabled="resultPage === pageCount - 1" @click="changeResultPage(1)">{{ t('Next models') }}</button>
      </div>
      <div ref="modelOptions" class="model-options" role="group" :aria-label="t('Available models')">
        <button v-if="selection.inherited && resultPage === 0 && !query.trim() && !activeProvider" class="model-option" :aria-pressed="selection.inheriting?.value" @click="choose('', close)">
          <span class="model-option-copy"><span>{{ conversationDefaults ? t('Follow configured default') : t('Follow project default') }}</span><small>{{ modelDisplayName(selection.inherited.value) }}</small></span>
        </button>
        <button v-for="model in visibleOptions" :key="model" class="model-option" :aria-pressed="!selection.inheriting?.value && model === selection.current.value" :title="model" @click="choose(model, close)">
          <span class="model-option-copy"><span>{{ modelDisplayName(model) }}</span><small v-if="modelProvider(model)">{{ modelCompactAccountLabel(model, selection.providers?.value) }}</small></span>
          <span v-if="!selection.inheriting?.value && model === selection.current.value" class="model-check i-lucide-check" aria-hidden="true" />
        </button>
        <p v-if="catalogLoading" class="model-empty" role="status">{{ t('Loading models...') }}</p>
        <p v-else-if="catalogError" class="model-empty" role="alert">{{ catalogError }}
          <button type="button" class="model-provider-tag" @click="catalogRetry++">{{ t('Retry models') }}</button>
        </p>
        <p v-else-if="!options.length" class="model-empty">{{ t('No matching models.') }}</p>
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
import { deepSeekReferenceRates } from '../../../src/providers/cost.ts'
import { CONTEXT_WINDOWS } from '../../../src/agent/llm-config.ts'
import { formatNumber, t } from '../i18n.ts'
import { hostBase } from '../api-url.ts'
import { createProviderSetupClient } from '../provider-setup.ts'
import type { ProviderUsage } from '../../../src/shared/provider-usage.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import ReasoningControls from './ReasoningControls.vue'
import { filterModelOptions, modelProviderFilters, modelProviderGroup, modelCompactAccountLabel, modelDisplayName, modelProvider, useModelSelection } from '../model-selection.ts'
import { contextWindowLabel, currentEffort, effortOptions, type ReasoningSettings } from '../session-settings.ts'

const props = defineProps<{ usageApiBase?: string; settings?: ReasoningSettings; settingsDisabled?: boolean; busy?: boolean; conversationDefaults?: boolean; futureRuns?: boolean }>()
const emit = defineEmits<{ 'change-settings': [patch: ReasoningSettings] }>()
const selection = useModelSelection()
const opened = ref(false)
const catalogLoading = ref(false)
const catalogError = ref('')
const catalogRetry = ref(0)
watch([opened, () => selection?.catalogRevision?.value, catalogRetry], async ([open], _previous, onCleanup) => {
  catalogLoading.value = false
  catalogError.value = ''
  if (!open || !selection?.loadCatalog) return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  catalogLoading.value = true
  try {
    await selection.loadCatalog(controller.signal)
  } catch (cause) {
    if (!controller.signal.aborted) catalogError.value = cause instanceof Error ? cause.message : t('Could not load project models. Retry.')
  } finally {
    if (!controller.signal.aborted) catalogLoading.value = false
  }
})
const query = ref('')
const MODELS_PER_PAGE = 60
const resultPage = ref(0)
const modelOptions = ref<HTMLElement>()
const activeProvider = ref('')
const page = ref<'menu' | 'model' | 'effort' | 'context'>(props.settings ? 'menu' : 'model')
const contextRow = ref<HTMLButtonElement>()
const contextLabel = computed(() => `${props.settings?.contextWindow == null ? t("Default · ") : ""}${contextWindowLabel(props.settings?.contextWindow ?? selection?.defaultReasoning?.value.contextWindow)}`)
const menu = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const modelRow = ref<HTMLButtonElement>()
const effortRow = ref<HTMLButtonElement>()
const unavailable = computed(() => !!selection?.disabled.value)
const pending = computed(() => !!props.busy || !!selection?.loading.value)
const effortChoice = computed(() => currentEffort(props.settings ?? {}))
const effectiveEffortLabel = computed(() => {
  const effective = effortChoice.value === 'default' ? currentEffort(selection?.defaultReasoning?.value ?? {}) : effortChoice.value
  return effective === 'default' ? '' : effortOptions.find(option => option.value === effective)!.label
})
const effortLabel = computed(() => effortChoice.value === 'default'
  ? effectiveEffortLabel.value ? t('Default · {label}', { label: effectiveEffortLabel.value }) : effortOptions[0].label
  : effectiveEffortLabel.value)
const providerLabel = computed(() => {
  const id = modelProvider(selection?.current.value ?? '')
  return selection?.providers?.value.find(provider => provider.id === id)?.name || id
})
const usageProvider = computed(() => modelProvider(selection?.current.value ?? ''))
const usageProviderType = computed(() => selection?.providers?.value.find(provider => provider.id === usageProvider.value)?.type)
const deepSeekRates = computed(() => usageProviderType.value === 'deepseek' || usageProviderType.value === 'deepseek-account'
  ? deepSeekReferenceRates(modelDisplayName(selection?.current.value ?? '')) : undefined)
const usageKind = computed(() => {
  const type = usageProviderType.value
  if (type === 'copilot' || type === 'copilot-v2') return 'copilot-credits'
  if (type === 'deepseek') return 'deepseek-balance'
})
const usage = ref<Exclude<ProviderUsage, { kind: 'unavailable' }>>()
const usageUnavailable = ref(false)
// Memory only, scoped to this selector and the exact host/provider instance.
const usageCache = new Map<string, { value: NonNullable<typeof usage.value>; fetchedAt: number }>()
const usageCacheTtl = 30_000
const usageCacheMaxAge = 300_000
const usageRevision = ref(0)
const invalidateUsageCache = () => {
  usageCache.clear()
  usageRevision.value++
}
onMounted(() => window.addEventListener('shadow:config-changed', invalidateUsageCache))
onBeforeUnmount(() => window.removeEventListener('shadow:config-changed', invalidateUsageCache))
watch([
  () => opened.value && page.value === 'menu' ? props.usageApiBase : undefined,
  usageProvider, usageKind, usageRevision,
], async ([base, provider, kind], _previous, onCleanup) => {
  usage.value = undefined
  usageUnavailable.value = false
  if (base === undefined || !provider || !kind) return
  const host = hostBase(base)
  const key = JSON.stringify([host, provider, kind])
  const cached = usageCache.get(key)
  if (cached) {
    const age = Date.now() - cached.fetchedAt
    if (age < usageCacheMaxAge) usage.value = cached.value
    if (age < usageCacheTtl) return
    if (age >= usageCacheMaxAge) usageCache.delete(key)
  }
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  try {
    const result = await createProviderSetupClient(host).usage(provider, controller.signal)
    if (controller.signal.aborted) return
    if (result.kind === kind) {
      usageCache.set(key, { value: result, fetchedAt: Date.now() })
      usage.value = result
    } else usageUnavailable.value = !usage.value
  } catch {
    if (!controller.signal.aborted) usageUnavailable.value = true
  }
})
const triggerTitle = computed(() => `${selection?.current.value || t('Choose model')}${props.settings && effectiveEffortLabel.value ? ` · ${effectiveEffortLabel.value}` : ''}`)
const allOptions = computed(() => filterModelOptions(selection?.options.value ?? [], selection?.current.value ?? '', '', selection?.providers?.value))
const providerFilters = computed(() => modelProviderFilters(allOptions.value, selection?.providers?.value))
const options = computed(() => filterModelOptions(allOptions.value, '', query.value, selection?.providers?.value)
  .filter(model => !activeProvider.value || !providerFilters.value.some(provider => provider.id === activeProvider.value) || modelProviderGroup(model, selection?.providers?.value) === activeProvider.value))
const pageCount = computed(() => Math.ceil(options.value.length / MODELS_PER_PAGE))
const visibleOptions = computed(() => options.value.slice(resultPage.value * MODELS_PER_PAGE, (resultPage.value + 1) * MODELS_PER_PAGE))
watch([options, page], () => {
  resultPage.value = 0
  if (modelOptions.value) modelOptions.value.scrollTop = 0
})
async function changeResultPage(delta: number) {
  resultPage.value += delta
  await nextTick()
  if (modelOptions.value) modelOptions.value.scrollTop = 0
  modelOptions.value?.querySelector?.<HTMLButtonElement>('.model-option')?.focus({ preventScroll: true })
}
function resetMenu() {
  resultPage.value = 0
  activeProvider.value = ''
  page.value = props.settings ? 'menu' : 'model'
  query.value = ''
  opened.value = true
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
.model-account { flex: 0 2 auto; min-width: 0; max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-muted); font-size: 11px; }
.model-chevron { flex: 0 0 14px; width: 14px; height: 14px; }
.model-effort { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap; }
.model-menu { display: flex; flex-direction: column; min-height: 0; }
.model-setting-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 40px; padding: 9px 10px; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.model-usage-row { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 9px 10px; color: var(--c-text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.model-usage-deepseek { flex-direction: column; align-items: flex-start; gap: 2px; }
.model-usage-row progress { flex: 1 1 72px; min-width: 24px; height: 5px; appearance: none; overflow: hidden; border: 0; border-radius: var(--radius-control); background: var(--c-bg-muted); }
.model-usage-row progress::-webkit-progress-bar { background: transparent; }
.model-usage-row progress::-webkit-progress-value { background: var(--c-blue); border-radius: var(--radius-control); }
.model-usage-row progress::-moz-progress-bar { background: var(--c-blue); border-radius: var(--radius-control); }
@media (forced-colors: active) { .model-usage-row progress { appearance: auto; } }
.model-setting-row:hover:not(:disabled) { background: var(--c-bg-muted); }
.model-setting-row:disabled { opacity: .5; cursor: not-allowed; }
.model-menu-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--c-text-secondary); }
.model-menu-back { display: inline-flex; align-items: center; gap: 6px; padding: 3px 0; border: 0; background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.model-menu-back:hover { color: var(--c-blue); }
.model-menu-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 8px 9px 12px; font-size: 13px; font-weight: 600; }
.model-scope { color: var(--c-text-secondary); font-size: 11px; font-weight: 400; }
.model-search { flex-shrink: 0; box-sizing: border-box; width: calc(100% - 8px); margin: 0 4px 8px; padding: 9px 10px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; }
.model-provider-filters { display: flex; gap: 6px; overflow-x: auto; flex-shrink: 0; padding: 2px 4px 8px; }
.model-provider-tag { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--c-control-border); border-radius: 999px; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.model-provider-tag:hover { background: var(--c-bg-muted); }
.model-provider-tag[aria-pressed="true"] { background: var(--c-selection-bg); color: var(--c-primary); border-color: currentColor; }
.model-provider-count { font-size: 11px; opacity: .75; }
.model-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px; padding: 2px 4px 8px; color: var(--c-text-secondary); font-size: 12px; }
@media (max-width: 700px), (pointer: coarse) { .model-pagination button { min-height: 44px; } }
.model-pagination button:disabled { opacity: .5; cursor: default; }
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
