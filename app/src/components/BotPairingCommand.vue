<template>
  <div class="pairing-command">
    <input :value="command" readonly :aria-label="t('Owner pairing command')" spellcheck="false" @focus="selectCommand" @click="selectCommand" />
    <button type="button" :disabled="busy" @click="copy">{{ copied ? t('Copied') : t('Copy pairing command') }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <span v-if="copied" class="sr-only" role="status">{{ t('Copied') }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { useTextCopy } from '../composables/useTextCopy.ts'
const props = defineProps<{ challenge: string }>()
const command = computed(() => `/shadow-pair ${props.challenge}`)
const { copied, busy, error, copy } = useTextCopy(command)
function selectCommand(event: Event) { (event.target as HTMLInputElement).select() }
</script>

<style scoped>
.pairing-command { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; min-width: 0; }
input { flex: 1 1 320px; min-width: 0; width: 100%; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: 13px monospace; user-select: text; }
button { padding: 8px 12px; min-height: 36px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text); cursor: pointer; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
p { flex-basis: 100%; margin: 0; color: var(--c-error); }
</style>
