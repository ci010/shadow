<template>
  <DesktopFrame>
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="auth-title" :aria-busy="session.busy.value">
        <h1 id="auth-title">{{ session.view.value === 'pairing' ? t('Connect this browser') : session.view.value === 'error' ? t('Cannot connect to Shadow') : t('Connecting to Shadow') }}</h1>
        <template v-if="session.view.value === 'pairing'">
          <p v-if="usePin">{{ t('Enter the shared PIN to access Shadow as an administrator on this computer.') }}</p>
          <p v-else>{{ t('Generate a short-lived, one-use pairing code in the trusted Shadow CLI, then enter it here.') }}</p>
          <form @submit.prevent="pair">
            <label for="pairing-code">{{ usePin ? t('Administrator PIN') : t('Pairing code') }}</label>
            <input id="pairing-code" v-model="code" :type="usePin ? 'password' : 'text'" autocomplete="off" autocapitalize="off" :spellcheck="false" required :disabled="session.busy.value" aria-describedby="pairing-help" autofocus>
            <p id="pairing-help" class="hint">{{ t('This browser stays signed in for up to 12 hours.') }} {{ usePin ? t('You can use the same PIN again after expiry or a backend restart.') : t('Your current page will open after pairing.') }}</p>
            <p v-if="session.error.value" class="auth-error" role="alert">{{ session.error.value }}</p>
            <button class="primary" type="submit" :disabled="session.busy.value || !code.trim()">{{ session.busy.value ? t('Connecting…') : t('Connect browser') }}</button>
          </form>
          <div class="auth-alternatives">
            <button type="button" :disabled="session.busy.value" @click="session.refresh()">{{ t('Check session') }}</button>
            <button v-if="session.status.value?.pinAvailable" type="button" :disabled="session.busy.value" @click="code = ''; pairingCode = !pairingCode">
              {{ usePin ? t('Use a one-use pairing code instead') : t('Use administrator PIN instead') }}
            </button>
          </div>
        </template>
        <template v-else-if="session.view.value === 'error'">
          <p class="auth-error" role="alert">{{ session.error.value }}</p>
          <button class="primary" :disabled="session.busy.value" @click="session.retry()">{{ session.busy.value ? t('Trying again…') : t('Retry') }}</button>
        </template>
        <p v-else role="status">{{ t('Checking this browser’s session…') }}</p>
      </section>
    </main>
  </DesktopFrame>
</template>

<script setup lang="ts">
import { t } from './i18n.ts'
import { computed, ref } from 'vue'
import DesktopFrame from './DesktopFrame.vue'
import type { BrowserSession } from './web-auth.ts'

const props = defineProps<{ session: BrowserSession }>()
const code = ref('')
const pairingCode = ref(false)
const usePin = computed(() => props.session.status.value?.pinAvailable && !pairingCode.value)
async function pair() {
  if (props.session.busy.value || !code.value.trim()) return
  const submitted = code.value
  code.value = ''
  if (usePin.value) await props.session.loginWithPin(submitted)
  else await props.session.pair(submitted)
}
</script>

<style scoped>
.auth-shell { box-sizing: border-box; min-height: 100%; display: grid; place-items: center; padding: 24px; background: var(--c-bg-soft); }
.auth-panel { box-sizing: border-box; width: min(440px, 100%); min-width: 0; padding: 28px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
h1 { margin: 0 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; }
p { margin: 0 0 24px; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
form { display: grid; gap: 10px; }
label { font-size: 13px; font-weight: 600; }
input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 8px 12px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.hint { margin: 0 0 10px; font-size: 12px; }
.auth-error { margin: 0 0 16px; color: var(--c-error); }
.auth-alternatives { display: grid; justify-items: center; gap: 4px; margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--c-border-soft); }
button { min-height: 44px; max-width: 100%; padding: 8px 14px; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); font: inherit; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; cursor: pointer; }
.auth-alternatives button { border-color: transparent; background: transparent; color: var(--c-text-secondary); }
.auth-alternatives button:not(:disabled):hover { color: var(--c-text); text-decoration: underline; text-underline-offset: 3px; }
button.primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: var(--c-primary-bg); }
button:not(:disabled):hover { background: var(--c-bg-muted); }
button.primary:not(:disabled):hover { background: var(--c-primary-bg-hover); }
button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 3px; }
@media (max-width: 480px) { .auth-shell { padding: 16px; } .auth-panel { padding: 24px 20px; } input { font-size: 16px; } }
</style>
