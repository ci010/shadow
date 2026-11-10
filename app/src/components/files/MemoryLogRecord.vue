<template>
  <article class="memory-record selectable-text" role="listitem" :data-source-line="record.start">
    <template v-if="record.kind === 'log'">
      <header class="memory-record-meta">
        <strong>{{ record.log.who }}</strong>
        <span v-if="record.log.when">{{ memoryLogTime(record.log.when) }}</span>
        <span class="memory-record-line">{{ t('Line') }} {{ record.start }}</span>
      </header>
      <p class="memory-record-what">{{ record.log.what }}</p>
      <dl class="memory-record-details">
        <template v-if="record.log.why">
          <dt>{{ t('Why') }}</dt><dd>{{ record.log.why }}</dd>
        </template>
        <template v-if="record.log.challenge">
          <dt>{{ t('Challenge') }}</dt><dd>{{ record.log.challenge }}</dd>
        </template>
        <template v-if="record.log.refs?.length">
          <dt>{{ t('References') }}</dt>
          <dd><ul class="memory-record-refs"><li v-for="(reference, index) in record.log.refs" :key="index"><code>{{ reference }}</code></li></ul></dd>
        </template>
        <template v-if="record.log.origin">
          <dt>{{ t('Session') }}</dt><dd class="memory-record-origin">{{ record.log.origin }}</dd>
        </template>
        <template v-for="field in record.extra" :key="field.name">
          <dt>{{ field.name }}</dt><dd>{{ field.value }}</dd>
        </template>
      </dl>
    </template>
    <template v-else>
      <p class="memory-record-warning" role="status">{{ t('Line') }} {{ record.start }} · {{ record.message }}</p>
      <pre class="memory-record-raw">{{ record.raw }}</pre>
    </template>
  </article>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { memoryLogTime, type MemoryLogRecord } from '../../memory-logs.ts'

defineProps<{ record: MemoryLogRecord }>()
</script>

<style scoped>
.memory-record { min-width: 0; padding: 24px 0; border-bottom: 1px solid var(--c-border); overflow-wrap: anywhere; }
.memory-record:first-child { padding-top: 8px; }
.memory-record:last-child { border-bottom: 0; }
.memory-record-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
.memory-record-meta strong { color: var(--c-text); font-size: 14px; font-weight: 600; }
.memory-record-line { margin-left: auto; font-variant-numeric: tabular-nums; }
.memory-record-what { margin: 10px 0 0; color: var(--c-text); font-size: 16px; line-height: 1.7; white-space: pre-wrap; }
.memory-record-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 14px 0 0; font-size: 14px; line-height: 1.6; }
.memory-record-details:empty { display: none; }
.memory-record-details dt { max-width: 14ch; color: var(--c-text-secondary); }
.memory-record-details dd { min-width: 0; margin: 0; white-space: pre-wrap; color: var(--c-text); }
.memory-record-refs { margin: 0; padding: 0; list-style: none; }
.memory-record-refs code, .memory-record-origin, .memory-record-raw { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; }
.memory-record-warning { margin: 0 0 12px; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
.memory-record-raw { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
@container memory-logs (max-width: 480px) {
  .memory-record-details { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .memory-record-details dt { max-width: none; margin-top: 8px; }
}
</style>
