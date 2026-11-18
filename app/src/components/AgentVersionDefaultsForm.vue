<template>
  <form class="agent-version-defaults" @submit.prevent="save">
    <h2>{{ t('Agent version defaults') }}</h2>
    <p class="settings-help">{{ t('General sets the version for new Web conversations without an explicit Agent. Existing conversations keep their version. Model settings are separate.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading Agent versions...') }}</p>
    <p v-if="error" role="alert" class="settings-error">
      {{ error }} <button type="button" class="btn" :disabled="loading || saving" @click="load">{{ t('Reload defaults') }}</button>
    </p>
    <fieldset v-if="roles.length" :disabled="loading || saving">
      <label v-for="role in roles" :key="role.role" class="settings-field">
        {{ roleLabel(role.role) }}
        <UiSelect v-model="selection[role.role]" :aria-label="roleLabel(role.role)"
          :disabled="loading || saving || role.versions.length < 2" @update:model-value="notice = ''">
          <option v-for="version in role.versions" :key="version.version" :value="version.version">
            {{ version.version.toUpperCase() }}{{ version.version === role.defaultVersion ? ` · ${t('Built-in default')}` : '' }}
          </option>
        </UiSelect>
      </label>
      <button class="btn save-defaults" type="submit" :disabled="!dirty || saving">{{ saving ? t('Saving...') : t('Save Agent defaults') }}</button>
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

type Role = { role: string; selectedVersion: string; defaultVersion: string; versions: { version: string }[] }
const props = defineProps<{ apiBase: string }>()
const roles = ref<Role[]>([])
const selection = ref<Record<string, string>>({})
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const dirty = computed(() => roles.value.some(role => selection.value[role.role] !== role.selectedVersion))
const path = '/api/app/agent-version-defaults'
let request: AbortController | undefined

function roleLabel(role: string) {
  switch (role) {
    case 'general': return t('General')
    case 'explore': return t('Explore')
    case 'plan': return t('Plan')
    case 'sub': return t('Subagent')
    case 'verify': return t('Verify')
    default: return role
  }
}

function accept(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.roles) || !value.roles.length) throw new Error('Invalid role catalog')
  const parsed = value.roles.map((role: unknown): Role => {
    if (!isRecord(role) || typeof role.role !== 'string' || typeof role.selectedVersion !== 'string' ||
      typeof role.defaultVersion !== 'string' || !Array.isArray(role.versions)) throw new Error('Invalid role')
    const versions = role.versions.map((option: unknown) => {
      if (!isRecord(option) || typeof option.version !== 'string') throw new Error('Invalid version')
      return { version: option.version }
    })
    if (!versions.some(option => option.version === role.selectedVersion) || !versions.some(option => option.version === role.defaultVersion)) throw new Error('Unknown version')
    return { role: role.role, selectedVersion: role.selectedVersion, defaultVersion: role.defaultVersion, versions }
  })
  roles.value = parsed
  selection.value = Object.fromEntries(parsed.map(role => [role.role, role.selectedVersion]))
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
  if (loading.value || saving.value || !dirty.value) return
  const active = request = new AbortController()
  saving.value = true
  error.value = notice.value = ''
  const patch = Object.fromEntries(roles.value.filter(role => selection.value[role.role] !== role.selectedVersion)
    .map(role => [role.role, selection.value[role.role]]))
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
