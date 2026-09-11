<template>
  <div class="desktop-frame" :class="{ 'native-desktop': controls }">
    <header class="desktop-title-bar" aria-label="Shadow">
      <span class="desktop-brand" aria-hidden="true">S</span>
      <span class="desktop-window-title">Shadow</span>
      <div v-if="$slots.navigation" class="chrome-navigation"><slot name="navigation" /></div>
      <div class="chrome-drag-space" aria-hidden="true" />
      <div v-if="$slots.actions" class="chrome-actions"><slot name="actions" /></div>
      <span v-if="error" class="window-error" role="alert">{{ error }}</span>
      <div v-if="controls" class="window-controls">
        <button aria-label="Minimize window" title="Minimize" @click="run(() => controls!.minimize())">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10"/></svg>
        </button>
        <button :aria-label="maximized ? 'Restore window' : 'Maximize window'" :title="maximized ? 'Restore' : 'Maximize'" @click="toggleMaximize">
          <svg v-if="maximized" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3V1h8v8H9M1 3h8v8H1z"/></svg>
          <svg v-else viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1h10v10H1z"/></svg>
        </button>
        <button class="window-close" aria-label="Close window" title="Close" @click="run(() => controls!.close())">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1 1 10 10M1 11 11 1"/></svg>
        </button>
      </div>
    </header>
    <div class="desktop-content"><slot /></div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { observeDesktopWindow } from './desktop-window.ts'

const controls = window.shadowDesktop?.windowControls
const maximized = ref(false)
const error = ref('')
let unsubscribe: (() => void) | undefined
async function run(action: () => Promise<unknown>) {
  error.value = ''
  try { await action() }
  catch { error.value = 'Window control failed. Please retry.' }
}
async function toggleMaximize() {
  if (controls) await run(async () => { maximized.value = (await controls.toggleMaximize()).maximized })
}
onMounted(() => {
  if (controls) unsubscribe = observeDesktopWindow(
    controls, (value) => { maximized.value = value },
    () => { error.value = 'Could not read window state.' },
  )
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<style scoped>
.desktop-frame { --desktop-title-height: 44px; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.desktop-content { flex: 1; min-height: 0; min-width: 0; overflow: auto; }
.desktop-title-bar { flex: 0 0 var(--desktop-title-height); min-width: 0; display: flex; align-items: center; gap: 10px; padding-left: 12px; background: var(--c-bg-card, #f7f9f7); color: var(--c-text, #18211d); border-bottom: 1px solid var(--c-border, #d8ddd9); z-index: 100; user-select: none; }
.native-desktop .desktop-title-bar { -webkit-app-region: drag; }
.desktop-brand { display: grid; place-items: center; width: 20px; height: 20px; color: white; background: #147a57; border-radius: var(--radius-control); font: 700 13px Georgia, serif; }
.desktop-brand, .desktop-window-title { flex-shrink: 0; }
.desktop-window-title { font: 600 12px "Segoe UI", sans-serif; }
.chrome-navigation { min-width: 0; flex: 0 1 auto; -webkit-app-region: no-drag; }
.chrome-drag-space { min-width: 32px; align-self: stretch; flex: 1 0 32px; }
.chrome-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; -webkit-app-region: no-drag; }
.window-controls { display: flex; align-self: stretch; flex-shrink: 0; -webkit-app-region: no-drag; }
.window-controls button { width: 46px; display: grid; place-items: center; border: 0; border-radius: 0; background: transparent; color: inherit; cursor: pointer; -webkit-app-region: no-drag; }
.window-controls button:hover { background: var(--c-bg-soft, #e5eae7); }.window-controls button:focus-visible { outline: 2px solid #147a57; outline-offset: -3px; }
.window-controls .window-close:hover { background: #c42b1c; color: white; }
svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1; }
.window-error { color: var(--c-error, #c42b1c); font-size: 11px; -webkit-app-region: no-drag; }
@media (max-width: 1000px) {
  .desktop-title-bar { gap: 6px; padding-left: 8px; }
  .window-controls button { width: 36px; }
}
@media (max-width: 560px) {
  .desktop-brand { display: none; }
  .chrome-drag-space { min-width: 12px; flex-basis: 12px; }
}
</style>
