<template>
  <section v-if="connected" class="mobile-connection" aria-label="Main connection">
    <details>
      <summary>Main connection{{ session.resourceError.value ? ' · File error' : '' }}</summary>
      <div class="connection-content">
        <strong>Connected to Main</strong>
        <p>{{ session.origin.value }}</p>
        <p>Sessions and tasks run on Main, not this device.</p>
        <p v-if="session.resourceError.value" role="alert">{{ session.resourceError.value }}</p>
        <div class="connection-actions">
          <button @click="session.refresh()">Retry connection</button>
          <button @click="session.disconnect()">Disconnect</button>
        </div>
      </div>
    </details>
  </section>
  <main v-else class="mobile-auth-shell">
    <section class="mobile-auth-panel" aria-labelledby="mobile-auth-title" :aria-busy="session.busy.value">
      <h1 id="mobile-auth-title">{{ session.view.value === 'pairing' ? 'Connect to Main' : session.view.value === 'error' ? 'Cannot connect to Main' : session.view.value === 'paused' ? 'Connection paused' : 'Connecting to Main' }}</h1>
      <p>This device is a Shadow client. Sessions and tasks run on your Main computer.</p>
      <form v-if="session.view.value === 'pairing'" @submit.prevent="pair">
        <label for="main-address">Main HTTPS address</label>
        <input id="main-address" v-model="endpoint" type="url" placeholder="https://shadow.example.com" autocomplete="url" autocapitalize="off" :spellcheck="false" :disabled="session.busy.value" required>
        <label for="mobile-pair-code">One-use pairing code</label>
        <input id="mobile-pair-code" v-model="code" type="password" autocomplete="off" autocapitalize="off" :spellcheck="false" :disabled="session.busy.value" required aria-describedby="mobile-pair-help">
        <p id="mobile-pair-help" class="hint">Generate a mobile pairing code in the trusted Main CLI. Codes expire after five minutes and work once. Credentials stay in this device’s secure storage.</p>
        <p v-if="session.error.value" class="connection-error" role="alert">{{ session.error.value }}</p>
        <button class="primary" type="submit" :disabled="session.busy.value || !endpoint.trim() || !code.trim()">{{ session.busy.value ? 'Connecting…' : 'Connect device' }}</button>
      </form>
      <template v-else>
        <p v-if="session.error.value" class="connection-error" role="alert">{{ session.error.value }}</p>
        <p v-else role="status">{{ session.view.value === 'paused' ? 'Live updates are paused while the app is in the background.' : 'Checking the secure connection…' }}</p>
        <div class="connection-actions">
          <button v-if="!session.busy.value && session.view.value !== 'paused'" class="primary" @click="session.credentials() ? session.refresh() : session.load()">Retry</button>
          <button :disabled="session.busy.value" @click="session.disconnect()">Disconnect / change Main</button>
        </div>
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MobileSession } from './mobile-client.ts'
const props = defineProps<{ session: MobileSession; connected?: boolean }>()
const endpoint = ref(props.session.origin.value)
const code = ref('')
async function pair() {
  const submitted = code.value
  code.value = ''
  await props.session.pair(endpoint.value, submitted)
}
</script>

<style scoped>
.mobile-auth-shell { min-height: 100dvh; display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--c-bg-soft); color: var(--c-text); }
.mobile-auth-panel { width: min(440px, 100%); padding: 24px; border: 1px solid var(--c-border); background: var(--c-bg-card); }
h1 { margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; }
p { margin: 0 0 18px; font-size: 14px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
form { display: grid; gap: 10px; }
label { font-size: 14px; font-weight: 600; }
input { width: 100%; min-width: 0; min-height: 48px; padding: 10px 12px; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 16px; }
.hint { font-size: 13px; margin: 0 0 10px; }
.connection-error { color: var(--c-error); }
.connection-actions { display: flex; flex-wrap: wrap; gap: 10px; }
button, summary { min-height: 48px; padding: 12px 14px; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 14px; cursor: pointer; }
button.primary { background: var(--c-primary-bg); border-color: var(--c-primary-bg); color: var(--c-text-on-primary); }
button:not(:disabled):hover, summary:hover { background: var(--c-bg-muted); }
button.primary:not(:disabled):hover { background: var(--c-primary-bg-hover); }
button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 3px; }
.mobile-connection { position: relative; max-width: calc(100vw - 24px); color: var(--c-text); }
.connection-content { width: min(360px, calc(100vw - 24px)); padding: 16px; background: var(--c-bg-card); border: 1px solid var(--c-border); box-shadow: 0 8px 24px var(--c-shadow); }
summary { width: fit-content; margin-left: auto; }
strong { display: block; margin-bottom: 8px; }
</style>
