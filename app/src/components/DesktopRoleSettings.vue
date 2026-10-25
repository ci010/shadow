<template>
  <section v-if="switchRole && current" class="desktop-role-settings" aria-labelledby="desktop-role-title">
    <h2 id="desktop-role-title">{{ t('Desktop role') }}</h2>
    <p>{{ t('Current role: {role}', { role: current === 'main' ? 'Main' : 'Child' }) }}</p>
    <p>{{ t('Main and Child keep separate settings and identities. Only one role runs at a time. Switching stops this runtime and restarts Shadow; running work may be interrupted. No existing data is moved or deleted.') }}</p>
    <template v-if="confirming">
      <p>{{ t('Switch to {role}? First-time setup opens automatically; an existing role resumes its saved configuration.', { role: target === 'main' ? 'Main' : 'Child' }) }}</p>
      <label v-if="target === 'child'"><input v-model="executionConsent" type="checkbox" :disabled="busy">{{ t('I allow the approved Main to read/write the work folder, create managed workdirs under Child home, and execute commands as my OS account.') }} <strong>{{ t('Shell access is not a sandbox and can access other host files.') }}</strong></label>
      <p>{{ t('If automatic restart is unavailable in a development launch, reopen Shadow manually after it closes.') }}</p>
      <button :disabled="busy || target === 'child' && !executionConsent" @click="apply">{{ t('Stop and switch role') }}</button>
      <button :disabled="busy" @click="confirming = false">{{ t('Cancel') }}</button>
    </template>
    <button v-else :disabled="busy" @click="confirming = true">{{ t('Switch to {role}', { role: target === 'main' ? 'Main' : 'Child' }) }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.ts'
const emit = defineEmits<{ active: [value: boolean] }>()
const switchRole = window.shadowDesktop?.bootstrap.switchRole
const current = ref<'main' | 'child' | null>(null)
const target = computed(() => current.value === 'main' ? 'child' : 'main')
const confirming = ref(false)
const executionConsent = ref(false)
const busy = ref(false)
const error = ref('')
watch(() => confirming.value || busy.value, active => emit('active', active), { flush: 'sync' })
onMounted(async () => {
  try { current.value = (await window.shadowDesktop?.bootstrap.load())?.mode ?? null } catch { /* Existing recovery UI owns setup load errors. */ }
})
async function apply() {
  if (!switchRole || busy.value || target.value === 'child' && !executionConsent.value) return
  busy.value = true
  error.value = ''
  try { await switchRole(target.value, executionConsent.value) }
  catch { error.value = t('Role switching could not finish. Your saved profiles are retained. Close and reopen Shadow before retrying; managed Main deployments cannot switch roles.'); busy.value = false }
}
</script>

<style scoped>
.desktop-role-settings { margin: 20px 0; padding: 16px; border: 1px solid var(--c-border); border-radius: 8px; }
p { color: var(--c-text-secondary); line-height: 1.5; }
button { margin: 12px 8px 0 0; padding: 8px 12px; }
label { display: block; line-height: 1.5; }
</style>
