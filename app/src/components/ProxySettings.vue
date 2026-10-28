<template>
  <section class="proxy-settings" aria-labelledby="proxy-title" :aria-busy="busy">
    <h2 id="proxy-title">{{ t('Proxy') }}</h2>
    <p>{{ t('Detect the system proxy on Main, not on this browser device. Environment proxy variables take precedence over Windows or macOS system proxy settings.') }}</p>
    <p>{{ t('This only controls proxy use by Shadow; it never changes operating system settings. Enabled by default, even when no proxy is detected.') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="state">
      <label class="proxy-toggle"><input type="checkbox" :checked="state.enabled" :disabled="busy" @change="change" />{{ t('Use detected system proxy') }}</label>
      <p role="status">{{ state.enabled ? t('Proxy use enabled') : t('Proxy use disabled: Shadow connects directly.') }}</p>
      <p v-if="state.detectionFailed">{{ t('Detected source') }}: {{ sourceLabel }}</p>
      <p v-if="state.detectionFailed" role="status">{{ t('Proxy detection failed. Unsupported or credential-bearing proxy settings are not displayed. You can still disable proxy use.') }}</p>
      <p v-else-if="!state.detected">{{ t('No system proxy detected. Shadow connects directly.') }}</p>
      <template v-else>
        <p>{{ t('Detected source') }}: {{ sourceLabel }}</p>
        <p v-if="state.source === 'windows-auto'">{{ t('Windows automatic proxy (PAC / auto-detect): the route is resolved separately for each destination.') }}</p>
        <p v-if="state.source === 'macos-auto'">{{ t('macOS automatic proxy (PAC / auto-discovery) is not supported. Configure a static system proxy or environment proxy, or disable proxy use to connect directly.') }}</p>
        <label v-if="state.http">HTTP<input :value="state.http" readonly /></label>
        <label v-if="state.https">HTTPS<input :value="state.https" readonly /></label>
      </template>
      <p>{{ t('Changes are saved and apply immediately to new Main requests and downloads. In-flight requests are not interrupted. Restart already-running microapps to apply the change; remote nodes and external tools manage their own proxy settings.') }}</p>
    </template>
    <button type="button" :disabled="busy" @click="refresh">{{ busy ? t('Loading…') : t('Detect again') }}</button>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { createProxySettingsClient, type ProxyStatus } from '../proxy-settings.ts'
const props = defineProps<{ apiBase: string }>()
const state = ref<ProxyStatus | null>(null)
const busy = ref(false)
const error = ref('')
let generation = 0
const sourceLabel = computed(() => ({ direct: t('No proxy'), environment: t('Environment variables'), 'windows-static': t('Windows static proxy'), 'windows-auto': t('Windows automatic proxy'), 'macos-static': t('macOS static proxy'), 'macos-auto': t('macOS automatic proxy'), unknown: t('Unknown') })[state.value?.source ?? 'unknown'])
async function run(enabled?: boolean, detect = false) {
  const current = ++generation
  busy.value = true; error.value = ''
  try {
    const client = createProxySettingsClient(props.apiBase)
    const next = detect ? await client.detect() : enabled === undefined ? await client.load() : await client.save(enabled)
    if (current === generation) state.value = next
  } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : t('Could not load proxy settings.') }
  finally { if (current === generation) busy.value = false }
}
function refresh() { void run(undefined, true) }
function change(event: Event) {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  input.checked = state.value?.enabled ?? true
  void run(enabled)
}
onMounted(() => { void run() })
watch(() => props.apiBase, () => { state.value = null; void run() })
</script>
<style scoped>
.proxy-settings { max-width: 680px; color: var(--c-text); }
h2 { margin-top: 0; font-size: 20px; }
p { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
label { display: flex; align-items: center; gap: 12px; margin: 16px 0; font-size: 14px; }
input[readonly] { width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--c-border); background: var(--c-bg-muted); color: var(--c-text); border-radius: 6px; }
button { padding: 10px 16px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-bg-muted); color: var(--c-text); cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.error { color: var(--c-red); }
</style>
