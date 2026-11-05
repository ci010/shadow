<template>
  <div ref="editor" class="reference-composer" :contenteditable="!disabled" :aria-disabled="disabled" :data-placeholder="placeholder" aria-multiline="true"
    @input="onInput" @beforeinput="beforeInput" @keydown="keydown" @paste="paste" @copy="copy" @cut="cut"
    @drop.prevent @dragstart.prevent
    @compositionstart="remember(); composing = true" @compositionend="compositionEnd" />
</template>
<script setup lang="ts">
import { h, onMounted, onBeforeUnmount, ref, render, watch } from 'vue'
import HoverInfo from './HoverInfo.vue'
import { t } from '../i18n.ts'
import { composerNodeText, composerOffset, composerPoint, composerReferences, type ComposerInput } from '../composer-references.ts'
const props = defineProps<{ modelValue: string; disabled?: boolean; placeholder?: string; images?: { reference: string; label: string; key: string; previewUrl?: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; preview: [key: string]; keydown: [event: KeyboardEvent] }>()
const editor = ref<HTMLElement>()
const composing = ref(false)
let current = props.modelValue
let chipMounts: HTMLElement[] = []
let history: { text: string; start: number; end: number }[] = []
let future: typeof history = []
function selection() {
  const root = editor.value, s = window.getSelection()
  if (!root || !s?.anchorNode || !s.focusNode || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return { start: 0, end: 0 }
  const anchor = composerOffset(root, s.anchorNode, s.anchorOffset), focus = composerOffset(root, s.focusNode, s.focusOffset)
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
}
function setSelectionRange(start: number, end: number) {
  const root = editor.value
  if (!root) return
  const range = document.createRange()
  range.setStart(...composerPoint(root, start)); range.setEnd(...composerPoint(root, end))
  const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(range)
}
function remember() { history.push({ text: current, ...selection() }); if (history.length > 100) history.shift(); future = [] }
function clearChips() { for (const mount of chipMounts) render(null, mount); chipMounts = [] }
function paint() {
  const root = editor.value
  if (!root || composing.value) return
  const focused = root.contains(document.activeElement), saved = selection()
  clearChips(); root.replaceChildren()
  let offset = 0
  for (const item of composerReferences(current, props.images)) {
    root.append(document.createTextNode(current.slice(offset, item.start)))
    const chip = document.createElement('span')
    chip.className = 'composer-reference'; chip.contentEditable = 'false'; chip.setAttribute('data-reference', item.raw)
    const label = item.kind === 'image' ? t('Preview {name}', { name: item.label }) : item.label
    render(h('span', { class: 'composer-reference-controls' }, [
      h(HoverInfo, { text: label }, { default: ({ triggerProps }: { triggerProps: object }) => h(item.href ? 'a' : 'button', {
        ...triggerProps, ...(item.href ? { href: item.href, target: '_blank', rel: 'noopener' } : { type: 'button', onClick: () => emit('preview', item.key!) }),
        class: 'composer-reference-source', 'aria-label': label, tabindex: props.disabled ? -1 : 0,
      }, [h('span', { class: item.kind === 'image' ? 'i-lucide-image' : 'i-lucide-messages-square', 'aria-hidden': 'true' }), item.label]) }),
      h(HoverInfo, { text: t('Remove {value1}', { value1: item.label }) }, { default: ({ triggerProps }: { triggerProps: object }) => h('button', {
        ...triggerProps, type: 'button', disabled: props.disabled, 'aria-label': t('Remove {value1}', { value1: item.label }),
        onClick: () => { if (!props.disabled) { remember(); replace(item.start, item.end, '') } },
      }, [h('span', { class: 'i-lucide-x', 'aria-hidden': 'true' })]) }),
    ]), chip)
    chipMounts.push(chip); root.append(chip); offset = item.end
  }
  root.append(document.createTextNode(current.slice(offset)))
  if (focused) setSelectionRange(saved.start, saved.end)
}
function publish(text: string) { current = text; emit('update:modelValue', text) }
function replace(start: number, end: number, text: string) {
  publish(current.slice(0, start) + text + current.slice(end)); paint()
  editor.value?.focus(); setSelectionRange(start + text.length, start + text.length)
  editor.value?.dispatchEvent(new Event('input', { bubbles: true }))
}
function onInput() {
  if (composing.value || !editor.value) return
  const saved = selection(), text = composerNodeText(editor.value)
  if (text === current) return
  // Some browser edit commands emit input without beforeinput.
  if (history.at(-1)?.text !== current) remember()
  publish(text); paint(); setSelectionRange(saved.start, saved.end)
}
function beforeInput(e: InputEvent) {
  if (props.disabled || composing.value || e.isComposing) return
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault(); remember(); const s = selection(); replace(s.start, s.end, '\n')
  } else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault(); undo(e.inputType === 'historyRedo')
  } else remember()
}
function compositionEnd() { composing.value = false; onInput() }
function undo(redo = false) {
  const from = redo ? future : history, to = redo ? history : future, state = from.pop()
  if (!state) return
  to.push({ text: current, ...selection() }); publish(state.text); paint(); setSelectionRange(state.start, state.end)
}
function keydown(e: KeyboardEvent) {
  if (e.target instanceof Element && e.target.closest('[data-reference]')) return
  if (props.disabled || composing.value || e.isComposing) return
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
    e.preventDefault(); undo(e.shiftKey || e.key.toLowerCase() === 'y'); return
  }
  // Delete an adjacent reference atomically, including its protocol metadata.
  const s = selection()
  if (s.start === s.end && (e.key === 'Backspace' || e.key === 'Delete')) {
    const item = composerReferences(current, props.images).find(item => e.key === 'Backspace' ? item.end === s.start : item.start === s.start)
    if (item) { e.preventDefault(); remember(); replace(item.start, item.end, ''); return }
  }
  emit('keydown', e)
}
function paste(e: ClipboardEvent) {
  // Parent owns file/image paste, including deduplication and attachment limits.
  if (e.defaultPrevented || props.disabled) return
  if (e.clipboardData?.files.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); return }
  const text = e.clipboardData?.getData('text/plain')
  if (text === undefined) return
  e.preventDefault(); remember(); const s = selection(); replace(s.start, s.end, text)
}
function copy(e: ClipboardEvent) {
  const s = selection()
  if (s.start === s.end) return
  e.preventDefault(); e.clipboardData?.setData('text/plain', current.slice(s.start, s.end))
}
function cut(e: ClipboardEvent) { if (props.disabled) return; copy(e); const s = selection(); if (s.start !== s.end) { remember(); replace(s.start, s.end, '') } }
watch(() => props.modelValue, value => {
  if (value === current) return
  remember(); current = value; paint()
})
watch(() => props.images, paint, { deep: true })
watch(() => props.disabled, paint)
onMounted(paint)
onBeforeUnmount(clearChips)
defineExpose<ComposerInput>({
  get selectionStart() { return selection().start }, get selectionEnd() { return selection().end },
  get disabled() { return !!props.disabled }, get readOnly() { return false },
  get style() { return editor.value!.style }, get scrollHeight() { return editor.value?.scrollHeight ?? 0 },
  focus: options => editor.value?.focus(options), setSelectionRange,
  closest: selector => editor.value?.closest(selector) ?? null,
  getClientRects: () => editor.value!.getClientRects(),
  getBoundingClientRect: () => editor.value!.getBoundingClientRect(),
})
</script>
<style>
.reference-composer { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 78px; max-height: min(240px, 28dvh); overflow-y: auto; padding: 3px 4px 10px; outline: 0; color: var(--c-text); font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.reference-composer:empty::before { content: attr(data-placeholder); color: var(--c-text-secondary); pointer-events: none; }
.reference-composer[aria-disabled="true"] { opacity: .6; pointer-events: none; }
.composer-reference { display: inline-block; max-width: 100%; vertical-align: baseline; white-space: normal; }
.composer-reference-controls { display: inline-flex; max-width: 100%; align-items: center; border: 1px solid var(--c-border); background: var(--c-bg-soft); font-size: 13px; vertical-align: middle; }
.composer-reference-controls button, .composer-reference-source { display: inline-flex; gap: 5px; align-items: center; min-height: 28px; padding: 2px 5px; border: 0; background: transparent; color: var(--c-text); text-decoration: none; cursor: pointer; font: inherit; overflow-wrap: anywhere; }
.composer-reference-source { min-width: 0; }
.composer-reference-controls button:hover, .composer-reference-source:hover { background: var(--c-bg-muted); color: var(--c-primary); }
.composer-reference-controls :focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.composer-reference-controls [class*="i-lucide"] { flex-shrink: 0; width: 14px; height: 14px; }
.mobile-chat .reference-composer { min-height: 44px; max-height: min(200px, 28dvh); padding: 10px 0; font-size: 16px; line-height: 1.5; }
</style>
