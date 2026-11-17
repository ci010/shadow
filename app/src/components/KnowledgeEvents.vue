<template>
  <div class="knowledge-events">
    <p v-if="!rows.length" class="muted">{{ t('No recorded events.') }}</p>
    <article v-for="row in rows" :key="row.line" class="knowledge-event">
      <template v-if="row.event">
        <p v-if="row.event.summary" class="event-summary">{{ row.event.summary }}</p>
        <dl>
          <dt>{{ t('When') }}</dt><dd>{{ row.event.when || t('Not recorded') }}</dd>
          <dt>{{ t('Who') }}</dt><dd>{{ row.event.who || t('Not recorded') }}</dd>
          <dt>{{ t('What happened') }}</dt><dd>{{ row.event.what || t('Not recorded') }}</dd>
          <dt>{{ t('Why') }}</dt><dd>{{ row.event.why || t('Not recorded') }}</dd>
          <template v-if="row.event.challenge"><dt>{{ t('Challenge') }}</dt><dd>{{ row.event.challenge }}</dd></template>
          <template v-if="row.event.origin"><dt>{{ t('Source session') }}</dt><dd><code>{{ row.event.origin }}</code></dd></template>
        </dl>
        <section v-if="row.event.refs.length" class="event-references" :aria-label="t('References')">
          <h3>{{ t('References') }}</h3>
          <ul><li v-for="(ref, index) in row.event.refs" :key="index"><button v-if="referenceTarget(ref)" type="button" @click="emit('select', referenceTarget(ref)!)">{{ ref }}</button><span v-else>{{ ref }}</span></li></ul>
        </section>
        <details><summary>{{ t('Recorded source') }} · {{ row.line }}</summary><pre>{{ row.source }}</pre></details>
      </template>
      <template v-else><p class="muted">{{ t('Unrecognized event record') }} · {{ row.line }}</p><pre>{{ row.source }}</pre></template>
    </article>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { parseKnowledgeEvents } from '../knowledge-events.ts'
import type { KnowledgeLink } from '../knowledge.ts'
const props = defineProps<{ content: string; links: KnowledgeLink[] }>()
const emit = defineEmits<{ select: [id: string] }>()
const rows = computed(() => parseKnowledgeEvents(props.content))
// Only catalog-resolved references are navigation targets. No authored URL is executed.
function referenceTarget(ref: string): string | undefined {
  return props.links.find(link => link.href === ref)?.target
}
</script>
<style scoped>
.knowledge-events { max-width: 75ch; }
.knowledge-event { padding: 16px 0; border-bottom: 1px solid var(--c-border); overflow-wrap: anywhere; }
.knowledge-event:first-child { padding-top: 0; }
.event-summary { font-weight: 500; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: 13px; line-height: 1.6; }
dt, .muted, summary { color: var(--c-text-muted); }
dd { margin: 0; white-space: pre-wrap; color: var(--c-text-body); }
.event-references h3 { font-size: 12px; font-weight: 500; margin: 16px 0 4px; }
ul { margin: 0; padding-left: 20px; }
button { color: var(--c-primary); text-align: left; overflow-wrap: anywhere; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
details { margin-top: 12px; }
summary { cursor: pointer; font-size: 12px; padding: 6px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; background: var(--c-bg-muted); padding: 12px; }
@media (max-width: 700px), (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
