<script setup lang="ts">
import { computed, ref } from 'vue'
import { t, type MessageKey } from '../../i18n.ts'
import { formatAlignmentLabRequest, parseAlignmentLabDocument, type AlignmentAnnotation, type AlignmentLabDocument } from '../../alignment-lab-model.ts'

const props = defineProps<{ modelValue: AlignmentLabDocument; selectedId?: string }>()
const emit = defineEmits<{ 'update:modelValue': [document: AlignmentLabDocument]; select: [id: string]; remove: [id: string]; clear: [] }>()
function sourceLabel(label: string) { return ['Animatic · simulated video shots','Synthesized PCM · 12 seconds'].includes(label) ? t(label as MessageKey) : label }
const selected = computed(() => props.modelValue.annotations.find(annotation => annotation.target.id === props.selectedId))
const summary = computed(() => { const s = selected.value?.target.selector; if (!s) return ''; if(s.type==='time-range') return `${t('Time range')} · ${s.start.toFixed(2)}–${s.end.toFixed(2)} s · ${s.trackId}`; if(s.type==='sequence') return `${t('Selected shots')} · ${s.itemIds.length} · ${s.shots?.at(-1)?.end.toFixed(1) ?? '—'} s`; return selected.value?.target.label ?? '' })
const ready = computed(() => !!props.modelValue.source.id)
const valid = computed(() => { try { return !!parseAlignmentLabDocument(props.modelValue) } catch { return false } })
const prepared = ref('')
const signature = ref('')
const notice = ref<MessageKey | ''>('')
const isCurrent = computed(() => !!prepared.value && signature.value === JSON.stringify(props.modelValue))
function change(field: 'description' | 'constraints', value: string) { emit('update:modelValue', { ...props.modelValue, [field]: value }) }
function changeAnnotation(field: 'intent' | 'description', value: string) {
  if (!selected.value) return
  emit('update:modelValue', { ...props.modelValue, annotations: props.modelValue.annotations.map(annotation => annotation.target.id === props.selectedId
    ? { ...annotation, [field]: value } as AlignmentAnnotation : annotation) })
}
function prepare() {
  try {
    prepared.value = formatAlignmentLabRequest(props.modelValue)
    signature.value = JSON.stringify(props.modelValue)
    notice.value = 'Request prepared locally. Nothing has been sent or executed.'
  } catch { notice.value = 'Select a valid target and describe the requested change, or add an overall change.' }
}
async function copy() {
  if (!isCurrent.value) return
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(prepared.value)
    notice.value = 'Copied. Paste into a chat and attach any referenced source files.'
  } catch { notice.value = 'Clipboard unavailable. Select and copy the request text below.' }
}
function download() {
  if (!valid.value) return
  const document = parseAlignmentLabDocument(props.modelValue)
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }))
  const link = window.document.createElement('a')
  link.href = url; link.download = `alignment-${document.kind}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <aside class="intent-inspector" :aria-label="t('Alignment intent and constraints')">
    <header><h2>{{ t('Intent and constraints') }}</h2><p>{{ t('Views locate the target. Describe the outcome here; the agent handles execution.') }}</p></header>
    <div v-if="ready" class="intent-source"><strong>{{ sourceLabel(modelValue.source.label) }}</strong><code :title="modelValue.source.revision">{{ modelValue.source.revision.slice(0, 16) }}</code></div>
    <label>{{ t('Overall requested change') }}<textarea class="intent-overall" :value="modelValue.description" rows="3" maxlength="8000" :disabled="!ready" :placeholder="t('What outcome do you want?')" @input="change('description', ($event.target as HTMLTextAreaElement).value)" /></label>
    <label>{{ t('Constraints and invariants') }}<textarea class="intent-constraints" :value="modelValue.constraints" rows="2" maxlength="8000" :disabled="!ready" :placeholder="t('What must remain unchanged? What should be avoided?')" @input="change('constraints', ($event.target as HTMLTextAreaElement).value)" /></label>
    <h3>{{ t('Anchored instructions') }} <span>{{ modelValue.annotations.length }}</span></h3>
    <p v-if="!modelValue.annotations.length" class="intent-hint">{{ t('Choose a range, object or relationship in the view to add an anchored instruction.') }}</p>
    <ol class="intent-targets"><li v-for="annotation in modelValue.annotations" :key="annotation.target.id"><button class="intent-target" :aria-pressed="selectedId === annotation.target.id" @click="emit('select', annotation.target.id)"><strong>{{ annotation.target.label }}</strong><span>{{ annotation.intent === 'preserve' ? t('Keep unchanged') : annotation.intent === 'reference' ? t('Use as reference') : t('Requested change') }}</span></button></li></ol>
    <div v-if="selected" class="intent-selected">
      <p class="intent-summary">{{ summary }}</p><details class="intent-anchor"><summary>{{ t('Selector details') }}</summary><code>{{ JSON.stringify(selected.target.selector) }}</code></details>
      <label>{{ t('Target intent') }}<select class="intent-kind" :value="selected.intent" @change="changeAnnotation('intent', ($event.target as HTMLSelectElement).value)"><option value="change">{{ t('Requested change') }}</option><option value="preserve">{{ t('Keep unchanged') }}</option><option value="reference">{{ t('Use as reference') }}</option></select></label>
      <label>{{ t('Target description') }}<textarea class="intent-description" :value="selected.description" maxlength="4000" rows="4" :placeholder="t('Describe the change, protection or reference for this target.')" @input="changeAnnotation('description', ($event.target as HTMLTextAreaElement).value)" /></label>
      <button class="btn intent-remove" @click="emit('remove', selected.target.id)">{{ t('Remove instruction') }}</button>
    </div>
    <p v-if="!valid" class="intent-hint">{{ t('Select a valid target and describe the requested change, or add an overall change.') }}</p>
    <div class="intent-actions"><button class="btn intent-prepare" :disabled="!valid" @click="prepare">{{ t('Prepare request') }}</button><button class="btn" :disabled="!isCurrent" @click="copy">{{ t('Copy request') }}</button><button class="btn" :disabled="!valid" @click="download">{{ t('Export JSON') }}</button><button class="btn" :disabled="!ready" @click="emit('clear')">{{ t('Clear this draft') }}</button></div>
    <p v-if="notice" class="intent-hint" role="status">{{ t(notice) }}</p>
    <p v-if="prepared && !isCurrent" class="intent-stale" role="status">{{ t('Instructions changed. Prepare the request again before copying.') }}</p>
    <details v-if="prepared" class="intent-output"><summary>{{ t('Prepared request text') }}</summary><textarea readonly :value="prepared" rows="12" :aria-label="t('Prepared request text')" @focus="($event.target as HTMLTextAreaElement).select()" /></details>
  </aside>
</template>

<style scoped>
.intent-inspector { min-width: 0; padding: 18px; background: var(--c-bg-card); border: 1px solid var(--c-border); }
h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 13px; margin: 20px 0 8px; } h3 span { color: var(--c-text-secondary); }
header p, .intent-hint { font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.intent-source { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; font-size: 12px; }.intent-source code { color: var(--c-text-secondary); }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; margin: 12px 0; }
textarea, select { width: 100%; padding: 8px; background: var(--c-bg-soft); color: var(--c-text); border: 1px solid var(--c-border); font: inherit; border-radius: var(--radius-control); } textarea { resize: vertical; }
.intent-targets { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; }.intent-target { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: start; padding: 9px; border: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); cursor: pointer; }.intent-target strong { font-size: 12px; overflow-wrap: anywhere; }.intent-target span { font-size: 11px; color: var(--c-text-secondary); }
.intent-target[aria-pressed="true"] { border-color: var(--c-blue); background: var(--c-bg-muted); }
.intent-anchor { max-height: 95px; overflow: auto; overflow-wrap: anywhere; font-size: 10px; color: var(--c-text-secondary); }
.intent-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }.intent-actions button { min-height: 36px; }
.intent-stale { color: var(--c-warning, #b45309); font-size: 12px; }.intent-output { margin-top: 14px; font-size: 12px; }.intent-output textarea { font: 11px/1.6 monospace; margin-top: 8px; }
@media (min-width: 761px) { .intent-inspector { position: sticky; top: 16px; max-height: calc(100dvh - 32px); overflow: auto; } }
button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
