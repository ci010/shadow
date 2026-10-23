<template>
  <section class="work-context-path" :aria-label="t('Goal path')">
    <h3>{{ t('Why this decision matters') }}</h3>
    <p v-if="unassessed.length" class="path-warning" role="status">{{ t('This question includes branches not yet reassessed after a goal change:') }} {{ unassessed.map(node => node.title).join(', ') }}. {{ t('Check the premise before choosing an answer; a new question does not make the old approach necessary.') }}</p>
    <ol>
      <li v-for="node in upper" :key="node.key" :class="{ anchor: node.key === context.decisionKey }">
        <p v-if="node.relation" class="path-link">{{ relationLabel(node.relation.kind) }}: {{ node.relation.reason }}</p>
        <button v-if="navigable" type="button" @click="emit('select', node.key)">{{ node.title }}</button>
        <strong v-else>{{ node.title }}</strong>
        <span v-if="node.key === context.decisionKey" class="anchor-label">{{ t('Choice at this level') }}</span>
        <p class="path-objective">{{ node.objective }}</p>
        <small>{{ node.origin === 'human' ? t('User-defined goal') : t('Working interpretation') }}</small>
        <p v-if="node.assessment" class="path-objective"><strong>{{ t('Impact assessment') }}</strong>: {{ node.assessment }}</p>
        <details v-if="node.userQuote"><summary>{{ t('User source') }}</summary><blockquote>{{ node.userQuote }}</blockquote></details>
      </li>
    </ol>
    <details v-if="lower.length" class="technical-origin">
      <summary>{{ t('Where this arose') }}: {{ lower.at(-1)?.title }}</summary>
      <ol><li v-for="node in lower" :key="node.key">
        <p v-if="node.relation" class="path-link">{{ relationLabel(node.relation.kind) }}: {{ node.relation.reason }}</p>
        <button v-if="navigable" type="button" @click="emit('select', node.key)">{{ node.title }}</button>
        <strong v-else>{{ node.title }}</strong>
        <p class="path-objective">{{ node.objective }}</p>
        <p v-if="node.assessment" class="path-objective"><strong>{{ t('Impact assessment') }}</strong>: {{ node.assessment }}</p>
      </li></ol>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { relationLabel } from '../project-work.ts'
import type { WorkDecisionContext } from '../../../src/initiatives/work-notes.ts'
const props = defineProps<{ context: WorkDecisionContext; navigable?: boolean }>()
const emit = defineEmits<{ select: [key: string] }>()
const index = computed(() => props.context.path.findIndex(node => node.key === props.context.decisionKey))
const upper = computed(() => props.context.path.slice(0, index.value + 1))
const lower = computed(() => props.context.path.slice(index.value + 1))
const unassessed = computed(() => props.context.path.filter(node => node.contextNeedsReview))
</script>
<style scoped>
.work-context-path { margin-bottom: 18px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
ol { list-style: none; margin: 0; padding: 0; }
li { margin: 0 0 10px; padding: 0 0 10px 12px; border-left: 1px solid var(--c-border); }
li.anchor { background: var(--c-bg-soft); padding-top: 8px; padding-right: 8px; }
strong, button { font-weight: 600; }
button { display: inline; border: 0; background: none; padding: 4px 0; text-align: left; font: inherit; font-weight: 600; color: var(--c-primary); cursor: pointer; }
button:hover { text-decoration: underline; text-underline-offset: 3px; }
.path-link, small { color: var(--c-text-secondary); font-size: 12px; }
.path-link { margin: 0 0 5px; }
.path-objective { max-width: 75ch; margin: 4px 0; white-space: pre-wrap; }
.anchor-label { display: inline-block; margin-left: 8px; color: var(--c-warn); font-size: 12px; }
summary { cursor: pointer; color: var(--c-text-secondary); }
blockquote { margin: 8px 0; white-space: pre-wrap; }
.technical-origin ol { margin-top: 12px; }
.path-warning { color: var(--c-warn); background: var(--c-warn-bg); padding: 8px; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
