<template>
  <article class="command-result" :class="{ 'command-failed': receipt.failed }" :data-command-id="receipt.id" :aria-label="t('Command result')">
    <header class="command-header">
      <code>{{ receipt.command }}</code>
      <MessageTimestamp :timestamp="receipt.timestamp" />
    </header>
    <p class="command-caption">{{ receipt.failed ? t('Command error') : t('Command result') }} {{ t('· Not sent to AI') }}</p>
    <div class="command-output" tabindex="0" role="region" :aria-label="t('Command output')">
      <slot />
    </div>
  </article>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import type { CommandReceipt } from '../../../src/slash-commands/receipt.ts'
import MessageTimestamp from './MessageTimestamp.vue'
defineProps<{ receipt: CommandReceipt }>()
</script>

<style scoped>
.command-result { margin: 16px 0; min-width: 0; padding: 12px 0; border-block: 1px solid var(--c-border); }
.command-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 16px; }
.command-header code { color: var(--c-text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.command-caption { margin: 4px 0 12px; font-size: 12px; color: var(--c-text-secondary); }
.command-failed .command-caption { color: var(--c-error); }
.command-output { min-width: 0; max-height: min(440px, 55dvh); overflow: auto; overflow-wrap: anywhere; }
.command-output:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.command-output :deep(.prose > :first-child) { margin-top: 0; }
.command-output :deep(.prose > :last-child) { margin-bottom: 0; }
</style>
