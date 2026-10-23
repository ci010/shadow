<template>
  <section v-if="enabled && (request || error)" class="credential-request" :aria-label="t('Private credential entry')">
    <form v-if="request" @submit.prevent="submit">
      <fieldset :disabled="busy || !secure">
        <legend>{{ t('Add credential privately') }}</legend>
        <p class="credential-purpose">{{ request.purpose }}</p>
        <p class="credential-reference">{{ t('Reference:') }} <code>{{ request.secretRef }}</code></p>
        <p :id="`${id}-privacy`" class="credential-note">{{ t('Only the reference and save/cancel status go to the assistant. The value is stored in this Project\'s credential file on Main; Shadow does not encrypt that file.') }}</p>
        <p class="credential-note">{{ request.replacesExisting ? t('This reference already has a value. ') : '' }}{{ t('Saving replaces any value stored under this reference.') }}</p>
        <label :for="id">{{ t('Credential value') }}</label>
        <input :id="id" v-model="secret" type="password" autocomplete="off" autocapitalize="off" :spellcheck="false"
          maxlength="16384" required :aria-describedby="`${id}-privacy`">
      </fieldset>
      <p v-if="!secure" class="credential-error" role="alert">{{ t('Use HTTPS or a local loopback connection to Main to enter credentials privately.') }}</p>
      <div class="credential-actions">
        <button type="button" :disabled="busy || !secure" @click="cancel">{{ operation === 'cancelling' ? t('Cancelling…') : t('Cancel') }}</button>
        <button type="submit" class="credential-save" :disabled="busy || !secure || !valid">{{ operation === 'saving' ? t('Saving…') : t('Save privately') }}</button>
      </div>
    </form>
    <p v-if="error" class="credential-error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="loading || busy" @click="refresh">{{ loading ? t('Reloading…') : t('Reload request') }}</button>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { useCredentialRequest } from '../credential-requests.ts'

const props = defineProps<{ apiBase: string; projectId: string; sessionId: string; active: boolean; stage?: string | null; canSubmit: boolean }>()
const id = `credential-${useId()}`
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const active = computed(() => props.active && documentVisible.value)
const { request, secret, error, loading, busy, operation, enabled, secure, valid, refresh, submit, cancel } = useCredentialRequest(
  () => ({ ...props, active: active.value }),
)
function updateVisibility() { documentVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', updateVisibility))
onUnmounted(() => document.removeEventListener('visibilitychange', updateVisibility))
</script>

<style scoped>
.credential-request { box-sizing: border-box; width: calc(100% - 40px); max-width: 860px; max-height: min(42dvh, 420px); flex: 0 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 8px auto 0; padding: 14px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 8px; padding: 0; font-size: 14px; font-weight: 600; }
p { margin: 6px 0; }
.credential-purpose { white-space: pre-wrap; }
.credential-note, .credential-reference { color: var(--c-text-secondary); font-size: 12px; }
label { display: block; margin-top: 12px; margin-bottom: 5px; }
input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 7px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.credential-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-weight: 500; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
.credential-save { margin-left: auto; background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.credential-save:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.credential-error { color: var(--c-error); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .credential-request { width: calc(100% - 24px); padding: 12px; } }
</style>
