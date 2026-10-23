<template>
  <button ref="trigger" class="browser-access-trigger" type="button" :aria-label="t('Connect browser')" :title="t('Connect browser')"
    aria-haspopup="dialog" :aria-expanded="open" @click="show">
    <span class="browser-access-icon i-lucide-monitor-smartphone" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <dialog v-if="open" ref="dialog" class="browser-access-dialog" :aria-labelledby="titleId" :aria-describedby="descriptionId"
      @cancel.prevent="close" @keydown.stop>
      <div class="dialog-heading">
        <h2 :id="titleId">{{ t('Connect a browser') }}</h2>
        <button class="btn ghost close-button" type="button" :aria-label="t('Close browser pairing')" @click="close">
          <span class="i-lucide-x w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <p :id="descriptionId">{{ t('Open Shadow in a browser on this computer and enter this one-use code.') }}</p>
      <p v-if="busy" role="status">{{ t('Generating pairing code...') }}</p>
      <template v-else-if="offer">
        <label :for="codeId">{{ t('Pairing code') }}</label>
        <output v-if="!expired" :id="codeId" class="pairing-code">{{ offer.code }}</output>
        <p v-else class="pairing-expired" role="status">{{ t('This code has expired. Generate a new code to continue.') }}</p>
        <p v-if="!expired" class="pairing-expiry">{{ t('Expires in') }} {{ remaining }}{{ t('. Each code can be used once.') }}</p>
        <p class="pairing-label">{{ t('Browser address') }}</p>
        <a class="browser-address selectable-text" :href="offer.url" @click.prevent="openBrowser">{{ offer.url }}</a>
      </template>
      <p v-if="error" class="pairing-error" role="alert">{{ error }}</p>
      <p v-if="copied" class="pairing-copied" role="status">{{ t('Pairing code copied.') }}</p>
      <div class="pairing-actions">
        <button class="btn" type="button" :disabled="busy" @click="generate">{{ offer ? t('Generate new code') : t('Retry') }}</button>
        <button v-if="offer" class="btn" type="button" :disabled="expired || busy" @click="openBrowser">{{ t('Open Web') }}</button>
        <button v-if="offer" class="btn primary" type="button" :disabled="expired || busy" @click="copy">{{ t('Copy code') }}</button>
      </div>
      <p class="pairing-note">{{ t('Keep this code private. Closing this panel does not revoke it; it expires after five minutes.') }}</p>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onUnmounted, ref, useId } from 'vue'
import type { DesktopWebPairing, DesktopWebPairingApi } from '../../../desktop/src/web-pairing-contract.ts'

const props = defineProps<{ api: DesktopWebPairingApi }>()
const titleId = useId()
const descriptionId = useId()
const codeId = useId()
const trigger = ref<HTMLButtonElement>()
const dialog = ref<HTMLDialogElement>()
const open = ref(false)
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const offer = ref<DesktopWebPairing>()
const now = ref(Date.now())
const expiresIn = computed(() => Math.max(0, Math.ceil((Date.parse(offer.value?.expiresAt ?? '') - now.value) / 1000)) || 0)
const expired = computed(() => expiresIn.value === 0)
const remaining = computed(() => `${Math.floor(expiresIn.value / 60)}:${String(expiresIn.value % 60).padStart(2, '0')}`)
let generation = 0
let timer: ReturnType<typeof setInterval> | undefined

async function show() {
  if (open.value) return
  open.value = true
  await nextTick()
  if (!open.value) return
  dialog.value?.showModal()
  timer = setInterval(() => { now.value = Date.now() }, 1000)
  await generate()
}
async function generate() {
  if (busy.value) return
  const current = ++generation
  busy.value = true
  error.value = ''
  copied.value = false
  offer.value = undefined
  try {
    const result = await props.api.create()
    if (current !== generation || !open.value) return
    now.value = Date.now()
    offer.value = result
  } catch {
    if (current === generation && open.value) error.value = t('Could not generate a pairing code. Check that Main is running, then retry.')
  } finally {
    if (current === generation) busy.value = false
  }
}
function currentOffer() {
  now.value = Date.now()
  return open.value && !expired.value ? offer.value : undefined
}
async function copy() {
  const value = currentOffer()
  if (!value) return
  const current = generation
  error.value = ''
  copied.value = false
  try {
    await navigator.clipboard.writeText(value.code)
    if (current === generation && open.value) copied.value = true
  } catch {
    if (current === generation && open.value) error.value = t('Could not copy the code. Select and copy the code above, or retry.')
  }
}
async function openBrowser() {
  const value = currentOffer()
  if (!value) return
  const current = generation
  error.value = ''
  try {
    if (!window.shadowDesktop?.openExternal) throw new Error(t('Desktop browser opener unavailable'))
    await window.shadowDesktop.openExternal(value.url)
  } catch {
    if (current === generation && open.value) error.value = t('Could not open your browser. Open the address above manually.')
  }
}
function clear() {
  generation++
  clearInterval(timer)
  timer = undefined
  offer.value = undefined
  busy.value = false
  copied.value = false
  error.value = ''
  dialog.value?.close()
  open.value = false
}
function close() {
  clear()
  trigger.value?.focus({ preventScroll: true })
}
onUnmounted(clear)
</script>

<style scoped>
.browser-access-trigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}
.browser-access-trigger:hover,
.browser-access-trigger[aria-expanded="true"] { color: var(--c-text); border-color: var(--c-border-hover); background: var(--c-bg-muted); }
.browser-access-trigger:active { background: var(--c-bg-soft); }
.browser-access-trigger:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.browser-access-icon { width: 14px; height: 14px; flex-shrink: 0; }
.browser-access-dialog { box-sizing: border-box; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.browser-access-dialog::backdrop { background: rgb(0 0 0 / 36%); }
.dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
h2 { margin: 0; font-size: 18px; font-weight: 600; }
.close-button { display: grid; place-items: center; min-width: 36px; min-height: 36px; }
p { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
label, .pairing-label { display: block; margin: 20px 0 8px; font-size: 12px; color: var(--c-text-secondary); }
.pairing-code { display: block; padding: 14px 12px; border: 1px solid var(--c-border); background: var(--c-bg-muted); font: 600 19px/1.6 var(--font-mono, monospace); text-align: center; overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
.pairing-expiry, .pairing-note { color: var(--c-text-secondary); }
.pairing-expiry { margin: 8px 0 0; }
.browser-address { display: block; color: var(--c-blue); font-size: 13px; overflow-wrap: anywhere; }
.pairing-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.pairing-actions .btn { min-height: 36px; }
.pairing-error, .pairing-expired { color: var(--c-error); }
.pairing-copied { color: var(--c-text); }
.pairing-note { margin: 16px 0 0; font-size: 12px; }
@media (max-width: 480px) { .browser-access-dialog { padding: 20px 16px; } }
</style>
