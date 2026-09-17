<template>
  <template v-for="node in nodes" :key="node.id">
    <div v-if="node.type === 'row' || node.type === 'column'" class="io-layout" :class="{ 'io-row': node.type === 'row' }">
      <IoNodes :nodes="node.children || []" :streams="streams" :disabled="disabled" @event="emit('event', $event)" />
    </div>
    <p v-else-if="node.type === 'text'" class="io-text">{{ node.text }}</p>
    <button v-else-if="node.type === 'button'" class="btn" :disabled="disabled" type="button" @click="send(node, true)">{{ node.text || node.id }}</button>
    <label v-else-if="node.type === 'input'" class="io-field">
      <span>{{ node.text || node.id }}</span>
      <input :type="node.inputType || 'text'" :data-io-control="node.id" :value="node.inputType === 'checkbox' ? undefined : drafts.get(node.id)?.value ?? node.value"
        :checked="node.inputType === 'checkbox' && node.value === true" :min="node.min" :max="node.max" :step="node.step"
        maxlength="4000" :disabled="disabled" @focus="focus(node, $event)" @input="edit(node, $event)" @blur="blur(node)" @change="input(node, $event)" />
    </label>
    <label v-else-if="node.type === 'select'" class="io-field">
      <span>{{ node.text || node.id }}</span>
      <select :value="node.value" :disabled="disabled" @change="send(node, ($event.target as HTMLSelectElement).value)">
        <option v-for="option in node.options || []" :key="option" :value="option">{{ option }}</option>
      </select>
    </label>
    <div v-else-if="node.type === 'table'" class="io-table" role="region" :aria-label="node.text || node.id" tabindex="0">
      <table><caption v-if="node.text">{{ node.text }}</caption><tbody><tr v-for="(row, index) in node.rows || []" :key="index"><td v-for="(cell, column) in row" :key="column">{{ cell }}</td></tr></tbody></table>
    </div>
    <IoCanvas v-else-if="node.type === 'canvas'" :node="node" />
    <IoMedia v-else-if="node.type === 'media' && node.sourceId && streams?.has(node.sourceId)" :stream="streams.get(node.sourceId)" :label="node.text || node.sourceId" />
    <p v-else-if="node.type === 'media'">This source is not active.</p>
  </template>
</template>
<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { IoPacket, IoUiNode } from '../../../../src/io/contracts.ts'
import IoCanvas from './IoCanvas.vue'
import IoMedia from './IoMedia.vue'
const props = defineProps<{ nodes: IoUiNode[]; streams?: Map<string, MediaStream>; disabled: boolean }>()
const emit = defineEmits<{ event: [packet: IoPacket] }>()
interface Draft { value: string; focused: boolean; dirty: boolean; valid: boolean; kind: string }
// Streaming views must not replace active edits or drafts the backend has not echoed.
const drafts = reactive(new Map<string, Draft>())
const editable = (node: IoUiNode) => node.type === 'input' && (!node.inputType || node.inputType === 'text' || node.inputType === 'number')
function echoed(node: IoUiNode, draft: Draft) {
  if (!draft.valid) return false
  return node.inputType === 'number'
    ? draft.value === '' ? node.value == null : Number(draft.value) === node.value
    : draft.value === String(node.value ?? '')
}
function focus(node: IoUiNode, event: Event) {
  if (!editable(node)) return
  const field = event.target as HTMLInputElement
  const draft = drafts.get(node.id)
  if (draft) draft.focused = true
  else drafts.set(node.id, { value: field.value, focused: true, dirty: false, valid: field.validity.valid, kind: node.inputType ?? 'text' })
}
function edit(node: IoUiNode, event: Event) {
  if (!editable(node)) return
  const field = event.target as HTMLInputElement
  drafts.set(node.id, { value: field.value, focused: document.activeElement === field, dirty: true, valid: field.validity.valid, kind: node.inputType ?? 'text' })
}
function blur(node: IoUiNode) {
  const draft = drafts.get(node.id)
  if (!draft) return
  draft.focused = false
  if (!draft.dirty || echoed(node, draft)) drafts.delete(node.id)
}
watch(() => props.nodes, nodes => {
  const current = new Map(nodes.map(node => [node.id, node]))
  for (const [id, draft] of drafts) {
    const node = current.get(id)
    if (!node || !editable(node) || draft.kind !== (node.inputType ?? 'text')
      || (!draft.focused && (!draft.dirty || echoed(node, draft)))) drafts.delete(id)
  }
})
function send(node: IoUiNode, value: unknown) {
  emit('event', { type: 'ui', id: node.id, ...(node.sourceId ? { sourceId: node.sourceId } : {}), value })
}
function input(node: IoUiNode, event: Event) {
  const field = event.target as HTMLInputElement
  if (!field.validity.valid) { field.reportValidity(); return }
  send(node, node.inputType === 'checkbox' ? field.checked : node.inputType === 'number' ? (Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : null) : field.value)
}
</script>
<style scoped>
.io-layout { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.io-row { flex-direction: row; flex-wrap: wrap; align-items: start; }
.io-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.io-field input, .io-field select { max-width: 100%; min-height: 36px; border: 1px solid var(--c-border); background: var(--c-bg-input); color: var(--c-text); padding: 6px 8px; }
.io-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.io-table { overflow: auto; max-height: 320px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 8px; border-bottom: 1px solid var(--c-border); overflow-wrap: anywhere; }
caption { text-align: left; font-weight: 600; padding-bottom: 8px; }
:is(button, input, select, [tabindex]):focus-visible { outline: 2px solid var(--c-info); outline-offset: 3px; }
</style>
