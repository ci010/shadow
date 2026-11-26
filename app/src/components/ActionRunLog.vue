<template>
  <section class="action-run" :aria-label="`${run.name} ${t('run')}`" :data-state="run.state">
    <div class="run-status" role="status"><span class="state"><span class="action-icon i-lucide-square-terminal" style="width:14px;height:14px" aria-hidden="true" />{{ t(run.state) }}</span><time :datetime="run.startedAt">{{ run.startedAt }}</time><span v-if="run.exitCode != null">{{ t('Exit code') }} {{ run.exitCode }}</span>
      <button v-if="canWrite && actionRunning(run)" type="button" :disabled="busy || run.state === 'stopping'" @click="emit('stop', run.id)"><span class="action-icon i-lucide-square" style="width:12px;height:12px" aria-hidden="true" />{{ run.state === 'stopping' ? t('Stopping…') : t('Stop') }}</button>
    </div>
    <details><summary>{{ run.name }} · {{ t('Logs') }}</summary><div class="log-content"><code>{{ run.command }}</code><h4>{{ t('Standard output') }}</h4><pre :aria-label="t('Standard output')" tabindex="0">{{ run.stdout || t('No standard output yet.') }}</pre><template v-if="run.stderr"><h4>{{ t('Standard error') }}</h4><pre class="stderr" :aria-label="t('Standard error')" tabindex="0">{{ run.stderr }}</pre></template></div></details>
  </section>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { actionRunning, type ActionRun } from '../quick-actions.ts'
defineProps<{ run: ActionRun; canWrite: boolean; busy: boolean }>()
const emit = defineEmits<{ stop: [id: string] }>()
</script>
<style scoped>
.action-icon { display: inline-block; flex: 0 0 auto; }
.action-run { margin: 8px 0; border-top: 1px solid var(--c-border-soft); color: var(--c-text-secondary); font-size: 12px; }
.run-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding-top: 8px; overflow-wrap: anywhere; }
.state { display: inline-flex; gap: 6px; align-items: center; color: var(--c-text); }
[data-state=failed] .state, .stderr { color: var(--c-error); }
[data-state=succeeded] .state { color: var(--c-success); }
time { font-variant-numeric: tabular-nums; }
summary { cursor: pointer; padding: 8px 0; overflow-wrap: anywhere; }
.log-content { padding: 12px; background: var(--c-bg-soft); }
code { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--c-text); }
h4 { font-size: 12px; font-weight: 500; margin: 16px 0 6px; }
pre { margin: 0; white-space: pre; max-height: 240px; overflow: auto; font-size: 12px; line-height: 1.6; color: var(--c-text-body); }
button { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; min-height: 32px; padding: 5px 10px; font: inherit; background: transparent; color: var(--c-text); border: 1px solid var(--c-border); cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:focus-visible, summary:focus-visible, pre:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 700px), (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
