<template>
  <form class="compaction-settings" @submit.prevent="save">
    <h2>{{ t('Conversation compaction') }}</h2>
    <p :id="descriptionId" class="settings-help">{{ t('Compact v2 applies across projects. Turn it off to use the previous compaction method. This does not change when automatic compaction runs.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading compaction settings...') }}</p>
    <p v-if="error" class="settings-error" role="alert">
      {{ error }} <button type="button" class="btn" :disabled="loading || saving" @click="load">{{ t('Reload settings') }}</button>
    </p>
    <fieldset v-if="saved !== undefined" :disabled="loading || saving">
      <label class="settings-checkbox">
        <input v-model="selection" type="checkbox" :aria-describedby="descriptionId" @change="notice = ''" />
        {{ t('Use Compact v2') }}
      </label>
      <button class="btn save-settings" type="submit" :disabled="!dirty">{{ saving ? t('Saving...') : t('Save compaction setting') }}</button>
    </fieldset>
    <p v-if="notice" class="settings-help" role="status">{{ notice }}</p>
  </form>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { isRecord } from '../folders-sidebar.ts'
import { t } from '../i18n.ts'
import { projectJson } from '../projects.ts'

const props = defineProps<{ apiBase: string }>()
const descriptionId = useId()
const path = '/api/app/compaction'
const saved = ref<boolean>()
const selection = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const dirty = computed(() => saved.value !== undefined && selection.value !== saved.value)
let request: AbortController | undefined

function accept(value: unknown) {
  if (!isRecord(value) || typeof value.compactV2 !== 'boolean') throw new Error('Invalid compaction setting')
  saved.value = selection.value = value.compactV2
}

async function load() {
  request?.abort()
  const active = request = new AbortController()
  loading.value = true
  saving.value = false
  saved.value = undefined
  error.value = notice.value = ''
  try {
    const value = await projectJson(props.apiBase, path, { signal: active.signal, cache: 'no-store' })
    if (!active.signal.aborted) accept(value)
  } catch {
    if (!active.signal.aborted) error.value = t('Could not load compaction settings.')
  } finally { if (request === active) loading.value = false }
}

async function save() {
  if (loading.value || saving.value || !dirty.value) return
  const active = request = new AbortController()
  saving.value = true
  error.value = notice.value = ''
  try {
    const value = await projectJson(props.apiBase, path, {
      method: 'PATCH', body: JSON.stringify({ compactV2: selection.value }), signal: active.signal,
    })
    if (active.signal.aborted) return
    accept(value)
    notice.value = t('Compaction setting saved.')
  } catch {
    if (!active.signal.aborted) error.value = t('Could not save compaction settings. Retry.')
  } finally { if (request === active) saving.value = false }
}

watch(() => props.apiBase, load, { immediate: true })
onUnmounted(() => request?.abort())
</script>

<style scoped>
.compaction-settings { margin-top: 32px; border-top: 1px solid var(--c-border); padding-top: 24px; }
h2 { margin: 0 0 16px; font-size: 20px; }
fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
.settings-checkbox { display: flex; align-items: center; gap: 8px; width: fit-content; min-height: 44px; margin: 8px 0; font-size: 14px; cursor: pointer; }
.settings-checkbox input { flex-shrink: 0; margin: 0; accent-color: var(--c-primary-bg); }
fieldset:disabled .settings-checkbox { cursor: default; }
.settings-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; }
.settings-error { color: var(--c-error); font-size: 13px; }
.btn { min-height: 44px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.save-settings { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.save-settings:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
