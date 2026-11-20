<template>
  <form class="agent-version-defaults" @submit.prevent="save">
    <h2>{{ t('Built-in prompt version') }}</h2>
    <p class="settings-help">{{ t('Applies across projects to new built-in Agent conversations and local delegations. Existing conversations, custom Agents and remote Agents are unchanged.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading Agent versions...') }}</p>
    <p v-if="error" role="alert" class="settings-error">
      {{ error }} <button type="button" class="btn" :disabled="loading || saving" @click="load">{{ t('Reload defaults') }}</button>
    </p>
    <p v-if="state?.source === 'environment'" role="status" class="settings-help">
      {{ state.version ? t('Controlled by SHADOW_BUILTIN_PROMPT_VERSION.') : t('SHADOW_BUILTIN_PROMPT_VERSION must be v1 or v2.') }}
    </p>
    <fieldset v-if="state?.version" :disabled="loading || saving || locked">
      <label class="settings-field">
        {{ t('Built-in prompt version') }}
        <UiSelect v-model="selection" :aria-label="t('Built-in prompt version')"
          :disabled="loading || saving || locked" @update:model-value="notice = ''">
          <option value="v1">V1</option>
          <option value="v2">V2</option>
        </UiSelect>
      </label>
      <button class="btn save-defaults" type="submit" :disabled="!dirty || saving || locked">{{ saving ? t('Saving...') : t('Save Agent defaults') }}</button>
    </fieldset>
    <p v-if="notice" role="status" class="settings-help">{{ notice }}</p>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isRecord } from '../folders-sidebar.ts'
import { t } from '../i18n.ts'
import { projectJson } from '../projects.ts'
import UiSelect from './UiSelect.vue'

type Version = 'v1' | 'v2'
type State = { version: Version | null; source: 'builtin' | 'app' | 'environment' }
const props = defineProps<{ apiBase: string }>()
const state = ref<State>()
const selection = ref<Version>('v2')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const locked = computed(() => state.value?.source === 'environment')
const dirty = computed(() => !!state.value?.version && selection.value !== state.value.version)
const path = '/api/app/agent-version-defaults'
let request: AbortController | undefined

function accept(value: unknown) {
  if (!isRecord(value) || (value.source !== 'builtin' && value.source !== 'app' && value.source !== 'environment') ||
    (value.version !== 'v1' && value.version !== 'v2' && !(value.version === null && value.source === 'environment'))) {
    throw new Error('Invalid built-in prompt version state')
  }
  state.value = { version: value.version, source: value.source }
  if (value.version) selection.value = value.version
}

async function load() {
  request?.abort()
  const active = request = new AbortController()
  loading.value = true
  error.value = notice.value = ''
  try {
    const value = await projectJson(props.apiBase, path, { signal: active.signal })
    if (!active.signal.aborted) accept(value)
  } catch {
    if (!active.signal.aborted) error.value = t('Could not load Agent defaults.')
  } finally { if (request === active) loading.value = false }
}

async function save() {
  if (loading.value || saving.value || locked.value || !dirty.value) return
  const active = request = new AbortController()
  saving.value = true
  error.value = notice.value = ''
  const patch = { version: selection.value }
  try {
    const value = await projectJson(props.apiBase, path, { method: 'PATCH', body: JSON.stringify(patch), signal: active.signal })
    if (active.signal.aborted) return
    accept(value)
    notice.value = t('Agent defaults saved.')
  } catch {
    if (!active.signal.aborted) error.value = t('Could not save Agent defaults.')
  } finally { if (request === active) saving.value = false }
}

onMounted(load)
onUnmounted(() => request?.abort())
</script>

<style scoped>
.agent-version-defaults { margin-top: 32px; border-top: 1px solid var(--c-border); padding-top: 24px; }
h2 { margin: 0 0 16px; font-size: 20px; }
fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
.settings-field { display: grid; gap: 8px; max-width: 360px; margin: 16px 0; font-size: 13px; }
.settings-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; }
.settings-error { color: var(--c-error); font-size: 13px; }
.btn { min-height: 36px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.save-defaults { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.save-defaults:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
</style>
