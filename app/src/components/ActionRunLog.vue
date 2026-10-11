<template>
  <section class="action-run" :aria-label="`${run.name} ${t('run')}`">
    <div class="run-status" role="status">{{ run.name }} · {{ t(run.state) }} · {{ run.startedAt }}<span v-if="run.exitCode != null"> · {{ t('Exit code') }} {{ run.exitCode }}</span>
      <button v-if="canWrite && actionRunning(run)" type="button" :disabled="busy || run.state === 'stopping'" @click="emit('stop', run.id)">{{ run.state === 'stopping' ? t('Stopping…') : t('Stop') }}</button>
    </div>
    <details><summary>{{ t('Logs') }}</summary><p>{{ run.command }}</p><pre :aria-label="t('Standard output')">{{ run.stdout || t('No standard output yet.') }}</pre><pre v-if="run.stderr" class="stderr" :aria-label="t('Standard error')">{{ run.stderr }}</pre></details>
  </section>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { actionRunning, type ActionRun } from '../quick-actions.ts'
defineProps<{ run: ActionRun; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ stop: [id: string] }>()
</script>
<style scoped>
.action-run { margin: 10px 0; padding: 8px; background: var(--c-bg-soft); border-radius: var(--radius-control); } .run-status { overflow-wrap: anywhere; font-size: 12px; } summary { cursor: pointer; margin-top: 8px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; font-size: 12px; } .stderr { color: var(--c-error); } p { overflow-wrap: anywhere; } button { margin-left: 8px; padding: 5px 10px; font: inherit; background: var(--c-bg-input); color: var(--c-text); border: 1px solid var(--c-control-border); border-radius: var(--radius-control); cursor: pointer; } button:focus-visible { outline: 2px solid var(--c-blue); } button:disabled { opacity: .5; }
</style>
