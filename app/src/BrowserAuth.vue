<template>
  <DesktopFrame>
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="auth-title" :aria-busy="session.busy.value">
        <h1 id="auth-title">{{ session.view.value === 'pairing' ? 'Connect this browser' : session.view.value === 'error' ? 'Cannot connect to Shadow' : 'Connecting to Shadow' }}</h1>
        <template v-if="session.view.value === 'pairing'">
          <p>Generate a short-lived, one-use pairing code in the trusted Shadow CLI, then enter it here.</p>
          <form @submit.prevent="pair">
            <label for="pairing-code">Pairing code</label>
            <input id="pairing-code" v-model="code" type="text" autocomplete="off" autocapitalize="off" :spellcheck="false" required :disabled="session.busy.value" aria-describedby="pairing-help" autofocus>
            <p id="pairing-help" class="hint">This browser stays signed in for up to 12 hours. Your current page will open after pairing.</p>
            <p v-if="session.error.value" class="auth-error" role="alert">{{ session.error.value }}</p>
            <div class="auth-actions">
              <button type="button" :disabled="session.busy.value" @click="session.refresh()">Check session</button>
              <button class="primary" type="submit" :disabled="session.busy.value || !code.trim()">{{ session.busy.value ? 'Connecting…' : 'Connect browser' }}</button>
            </div>
          </form>
        </template>
        <template v-else-if="session.view.value === 'error'">
          <p class="auth-error" role="alert">{{ session.error.value }}</p>
          <button class="primary" :disabled="session.busy.value" @click="session.retry()">{{ session.busy.value ? 'Trying again…' : 'Retry' }}</button>
        </template>
        <p v-else role="status">Checking this browser’s session…</p>
      </section>
    </main>
  </DesktopFrame>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import DesktopFrame from './DesktopFrame.vue'
import type { BrowserSession } from './web-auth.ts'

const props = defineProps<{ session: BrowserSession }>()
const code = ref('')
async function pair() {
  if (props.session.busy.value || !code.value.trim()) return
  const submitted = code.value
  code.value = ''
  await props.session.pair(submitted)
}
</script>

<style scoped>
.auth-shell { min-height: 100%; display: grid; place-items: center; padding: 24px; background: var(--c-bg-soft); }
.auth-panel { width: min(440px, 100%); padding: 28px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
h1 { margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; }
p { margin: 0 0 24px; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
form { display: grid; gap: 10px; }
label { font-size: 13px; font-weight: 600; }
input { width: 100%; min-width: 0; min-height: 42px; padding: 8px 12px; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.hint { margin: 0 0 10px; font-size: 12px; }
.auth-error { margin: 0 0 16px; color: var(--c-error); }
.auth-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); font: inherit; font-size: 13px; cursor: pointer; }
button.primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: var(--c-primary-bg); }
button:not(:disabled):hover { background: var(--c-bg-muted); }
button.primary:not(:disabled):hover { background: var(--c-primary-bg-hover); }
button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 3px; }
@media (max-width: 480px) { .auth-shell { padding: 16px; } .auth-panel { padding: 22px 18px; } }
</style>
