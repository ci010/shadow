<template>
  <div class="work-report-content">
    <p v-if="summary && compact" class="note-summary-preview">{{ summary }}</p>
    <WorkMarkdownContent v-else-if="summary" class="note-summary" :text="summary" />
    <template v-if="!compact">
      <section v-if="artifacts.length"><h4>{{ t('Linked artifacts') }}</h4><ul><li v-for="(artifact, index) in artifacts" :key="index">
        <a :href="artifact.href.startsWith('/') ? apiUrl(apiBase, artifact.href).href : artifact.href" target="_blank" rel="noopener noreferrer">{{ artifact.label }}</a>
      </li></ul></section>
      <p v-if="contextAssessment" class="impact-conclusion"><strong>{{ t('Impact assessment') }}</strong> {{ contextAssessment }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import type { WorkArtifact } from '../../../src/initiatives/work-notes.ts'
import WorkMarkdownContent from './WorkMarkdownContent.vue'
defineProps<{ summary: string; artifacts: WorkArtifact[]; contextAssessment?: string; apiBase: string; compact?: boolean }>()
</script>
<style scoped>
.work-report-content { min-width: 0; line-height: 1.6; overflow-wrap: anywhere; }
p { max-width: 75ch; margin: 8px 0; white-space: pre-wrap; }
.note-summary-preview { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
strong { font-weight: 500; margin-right: 6px; }
section { margin-top: 16px; }
h4 { margin: 0 0 5px; font: inherit; font-weight: 600; }
ul { padding-left: 22px; margin: 0; }
li + li { margin-top: 4px; }
a { color: var(--c-primary); text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.impact-conclusion { font-size: 12px; color: var(--c-text-secondary); }
</style>
