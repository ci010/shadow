<template>
  <main class="upgrade-shell">
    <section aria-labelledby="upgrade-title">
      <h1 id="upgrade-title">{{ t('Upgrade your data folder') }}</h1>
      <p>{{ t('Shadow detected an older data layout. The backend stays stopped until the upgrade finishes.') }}</p>
      <code>{{ layout.dataDir }}</code>
      <p>{{ t('This upgrade moves data into the new layout; it does not retain a complete old snapshot. Make your own offline backup first if you need one.') }}</p>
      <p><strong>{{ t('Quit every other Shadow Desktop, Main, service and development process that can write to this folder. This window cannot verify that old processes are stopped.') }}</strong></p>
      <p v-if="layout.reason">{{ layout.reason }}</p>
      <label v-if="layout.status === 'migration-required'"><input v-model="offline" type="checkbox" :disabled="running"> {{ t('I have stopped all other writers and am ready to upgrade offline.') }}</label>
      <div v-if="running || layout.progress" role="status" aria-live="polite">
        <strong>{{ phaseLabel }}</strong>
        <span v-if="layout.progress && layout.progress.total && layout.progress.total > 0"> — {{ layout.progress.completed }} / {{ layout.progress.total }}</span>
        <p>{{ t('Counts describe migration entries or published roots, not elapsed time or a percentage of bytes.') }}</p>
      </div>
      <p v-if="error || layout.error" role="alert">{{ error || layout.error }}</p>
      <p v-if="layout.status === 'blocked' || layout.error">{{ t('Keep writers stopped. Inspect the migration receipt, staging and lock using the bundled data-migration diagnostics. Follow docs/data-migration.md for recovery or explicit offline rollback. Shadow will not delete data, reset setup or clear locks automatically.') }}</p>
      <button v-if="layout.status === 'migration-required'" :disabled="running || !offline" @click="start">{{ running ? t('Upgrading…') : layout.error ? t('Retry upgrade') : t('Start upgrade') }}</button>
      <button v-if="!running" @click="refresh">{{ t('Check again') }}</button>
    </section>
  </main>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DataLayoutView } from '../../desktop/src/bootstrap/data-layout-controller.ts'
import type { ShadowDesktopApi } from './desktop-bootstrap.ts'
import { t } from './i18n.ts'
const props = defineProps<{ api: ShadowDesktopApi; initialLayout: DataLayoutView }>()
const emit = defineEmits<{ complete: [] }>()
const layout = ref(props.initialLayout)
const offline = ref(false)
const running = ref(props.initialLayout.running)
const error = ref('')
let disposed = false
let finished = false
function complete() { if (!finished && !disposed) { finished = true; emit('complete') } }
let timer: ReturnType<typeof setInterval> | undefined
const phaseLabel = computed(() => {
  const phase = layout.value.progress?.phase
  return phase === 'inventory' ? t('Inspecting legacy data…') : phase === 'staging' ? t('Moving data into staging…') : phase === 'publishing' ? t('Publishing upgraded data…') : phase === 'complete' ? t('Verifying upgrade…') : t('Starting upgrade…')
})
async function refresh() {
  try {
    const next = await props.api.bootstrap.dataLayoutStatus?.()
    if (disposed || !next) return
    layout.value = next
    if (next.status === 'ready' && !next.running) complete()
  } catch (e) { error.value = e instanceof Error ? e.message : t('Could not inspect the data folder. Retry.') }
}
async function start() {
  if (!offline.value || running.value) return
  running.value = true
  error.value = ''
  timer = setInterval(() => { void refresh() }, 300)
  try {
    const next = await props.api.bootstrap.upgradeDataLayout?.()
    if (!disposed && next) {
      layout.value = next
      if (next.status === 'ready') complete()
    }
  } catch (e) { error.value = e instanceof Error ? e.message : t('Upgrade failed. Keep writers stopped and inspect recovery diagnostics.') }
  finally { running.value = false; clearInterval(timer) }
}
onMounted(() => { if (running.value) timer = setInterval(() => { void refresh() }, 300) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer) })
</script>
<style scoped>
.upgrade-shell { min-height: 100%; display: grid; place-items: center; padding: 40px 24px; }
section { width: min(640px, 100%); display: grid; gap: 16px; }
h1 { font-size: 24px; font-weight: 600; } p { line-height: 1.6; } code { overflow-wrap: anywhere; } label { display: flex; align-items: start; gap: 8px; }
button { padding: 10px 16px; border: 1px solid currentColor; border-radius: 8px; } button:disabled { opacity: .5; }
</style>
