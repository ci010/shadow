<template>
  <section class="completion-history" :aria-label="t('Completed work')">
    <header><h2>{{ t(unreadOnly ? 'Newly completed work' : 'Completed work') }}</h2>
      <button type="button" :aria-pressed="unreadOnly" @click="emit('update:unreadOnly', !unreadOnly)">{{ t('Unread only') }}</button>
      <button type="button" :disabled="busy || !unreadCount" @click="emit('readAll')">{{ t('Mark all as read') }}</button>
    </header>
    <p class="read-notice">{{ t('Read means seen, not accepted. It does not change Work or notify agents.') }}</p>
    <p v-if="!groups.length" class="empty" role="status">{{ t('No matching completed work') }}</p>
    <section v-for="group in groups" :key="group.day" class="completion-day">
      <h3>{{ group.day }}</h3>
      <article v-for="row in group.rows" :key="row.item.key" :class="{ unread: row.completion?.unread }">
        <div class="result-heading"><button type="button" @click="emit('select', row.item.key)">{{ row.item.title }}</button><span v-if="row.completion?.unread" class="unread-label">{{ t('Unread') }}</span></div>
        <time v-if="row.completion?.completedAt" :datetime="row.completion.completedAt">{{ new Date(row.completion.completedAt).toLocaleString() }}</time>
        <p v-if="row.item.result?.summary || row.item.notes?.summary">{{ row.item.result?.summary ?? row.item.notes?.summary }}</p>
        <ul v-if="row.item.notes?.artifacts?.length"><li v-for="artifact in row.item.notes.artifacts" :key="artifact.href"><a :href="artifact.href.startsWith('/') ? apiUrl(apiBase, artifact.href).href : artifact.href" target="_blank" rel="noopener noreferrer">{{ artifact.label }}</a></li></ul>
      </article>
    </section>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import type { ProjectWorkItem } from '../../../src/projects/work-overview.ts'
import type { WorkCompletion } from '../../../src/initiatives/work-contract.ts'
const props = defineProps<{ items: ProjectWorkItem[]; completions: WorkCompletion[]; unreadOnly: boolean; unreadCount: number; busy: boolean; apiBase: string }>()
const emit = defineEmits<{ select: [key: string]; readAll: []; 'update:unreadOnly': [value: boolean] }>()
const groups = computed(() => {
  const completions = new Map(props.completions.map(item => [item.key, item]))
  const rows = props.items.filter(item => item.status === 'done').map(item => ({ item, completion: completions.get(item.key) }))
    .filter(row => !props.unreadOnly || row.completion?.unread)
    .sort((a, b) => (b.completion?.completedAt ?? '').localeCompare(a.completion?.completedAt ?? '') || a.item.title.localeCompare(b.item.title))
  const days = new Map<string, typeof rows>()
  for (const row of rows) {
    const day = row.completion?.completedAt ? new Date(row.completion.completedAt).toLocaleDateString() : t('Completion time unavailable')
    const group = days.get(day) ?? []; group.push(row); days.set(day, group)
  }
  return [...days].map(([day, rows]) => ({ day, rows }))
})
</script>
<style scoped>
.completion-history { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
header, .result-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
h2 { flex: 1; margin: 0; font-size: 15px; }
h3 { margin: 24px 0 8px; font-size: 12px; color: var(--c-text-secondary); font-weight: 500; }
article { padding: 12px 0; border-top: 1px solid var(--c-border-soft); overflow-wrap: anywhere; }
p { margin: 8px 0; max-width: 75ch; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
time, .read-notice, .empty { color: var(--c-text-secondary); font-size: 12px; }
.unread-label { font-size: 12px; color: var(--c-info); }
button { min-height: 34px; padding: 5px 9px; font: inherit; font-size: 12px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
[aria-pressed=true] { color: var(--c-primary); background: var(--c-selection-bg); }
.result-heading button { padding-left: 0; border: 0; background: transparent; font-size: 14px; text-align: left; font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
a { color: var(--c-primary); text-underline-offset: 3px; }
ul { margin: 8px 0; padding-left: 20px; font-size: 13px; }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } }
</style>
