<template>
  <div class="work-note-content">
    <p v-if="notes.summary" class="note-summary">{{ notes.summary }}</p>
    <p v-if="notes.next"><strong>{{ t('Next action') }}</strong> {{ notes.next }}</p>
    <template v-if="!compact">
      <section v-if="notes.plan.length"><h4>{{ t('Working plan') }}</h4><ol><li v-for="(step, index) in notes.plan" :key="index">{{ step }}</li></ol></section>
      <section v-if="notes.artifacts.length"><h4>{{ t('Linked artifacts') }}</h4><ul><li v-for="(artifact, index) in notes.artifacts" :key="index">
        <a :href="artifact.href.startsWith('/') ? apiUrl(apiBase, artifact.href).href : artifact.href" target="_blank" rel="noopener noreferrer">{{ artifact.label }}</a>
      </li></ul></section>
      <WorkExhibit v-if="notes.html" :html="notes.html" />
      <p v-if="notes.attention?.reviewed" class="impact-conclusion"><strong>{{ t('Impact assessment') }}</strong> {{ notes.attention.reviewed.conclusion }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import type { WorkNotes } from '../../../src/initiatives/work-notes.ts'
import WorkExhibit from './WorkExhibit.vue'
defineProps<{ notes: WorkNotes; apiBase: string; compact?: boolean }>()
</script>
<style scoped>
.work-note-content { min-width: 0; line-height: 1.6; overflow-wrap: anywhere; }
p { max-width: 75ch; margin: 8px 0; white-space: pre-wrap; }
strong { font-weight: 500; margin-right: 6px; }
section { margin-top: 16px; }
h4 { margin: 0 0 5px; font: inherit; font-weight: 600; }
ol, ul { padding-left: 22px; margin: 0; }
li + li { margin-top: 4px; }
a { color: var(--c-primary); text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.impact-conclusion { font-size: 12px; color: var(--c-text-secondary); }
</style>
