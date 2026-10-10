<template>
  <div class="ui-combobox">
    <input ref="input" v-bind="$attrs" :value="modelValue" role="combobox" aria-autocomplete="list" :aria-expanded="open && matches.length > 0" :aria-controls="id" :aria-activedescendant="open && active >= 0 ? `${id}-${active}` : undefined" @input="update" @focus="open = true" @blur="blur" @keydown="keydown" />
    <Teleport to="body"><ul v-if="open && matches.length" ref="panel" :id="id" role="listbox" :style="position">
      <li v-for="(option, index) in matches" :id="`${id}-${index}`" :key="option" role="option" :aria-selected="index === active" :class="{ active: index === active }" @pointerdown="prepareClick" @click="choose(option)" @pointermove="hover($event, index)">{{ option }}</li>
    </ul></Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { selectPopupPosition } from '../select-control.ts'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue: string; options: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const id = useId()
const input = ref<HTMLInputElement>()
const open = ref(false)
const active = ref(-1)
const panel = ref<HTMLElement>()
const position = ref<Record<string, string>>({})
function place() {
  if (!open.value || !input.value || !panel.value) return
  const rect = input.value.getBoundingClientRect()
  const viewport = window.visualViewport
  const result = selectPopupPosition(rect, { width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }, Math.min(248, matches.value.length * 44 + 8), rect.width)
  position.value = { left: `${result.left}px`, top: `${result.top}px`, width: `${result.width}px`, maxHeight: `${result.maxHeight}px` }
}
function dismissOnScroll(event: Event) { if (event.target !== panel.value) open.value = false }
watch([open, () => props.modelValue, () => props.options], async () => { await nextTick(); place() }, { deep: true })
watch(open, value => {
  if (value) { window.addEventListener('resize', place); window.addEventListener('scroll', dismissOnScroll, true); window.visualViewport?.addEventListener('resize', place) }
  else cleanup()
})
function cleanup() { window.removeEventListener('resize', place); window.removeEventListener('scroll', dismissOnScroll, true); window.visualViewport?.removeEventListener('resize', place) }
onUnmounted(cleanup)
const matches = computed(() => props.options.filter(option => option.toLocaleLowerCase().includes(props.modelValue.toLocaleLowerCase())))
function update(event: Event) { emit('update:modelValue', (event.target as HTMLInputElement).value); active.value = -1; open.value = true }
function choose(value: string) { emit('update:modelValue', value); open.value = false; active.value = -1 }
let touching = false
function prepareClick(event: PointerEvent) { if (event.pointerType === 'touch') touching = true; else event.preventDefault() }
function blur() { if (!touching) open.value = false }
function releaseTouch() { touching = false; window.setTimeout(() => { if (document.activeElement !== input.value) open.value = false }, 0) }
watch(open, value => { if (value) window.addEventListener('pointerup', releaseTouch); else window.removeEventListener('pointerup', releaseTouch) })
onUnmounted(() => window.removeEventListener('pointerup', releaseTouch))
function hover(event: PointerEvent, index: number) { if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) active.value = index }
watch(active, async index => { await nextTick(); const item = panel.value?.children[index] as HTMLElement | undefined; if (!item || !panel.value) return; if (item.offsetTop < panel.value.scrollTop) panel.value.scrollTop = item.offsetTop; else if (item.offsetTop + item.offsetHeight > panel.value.scrollTop + panel.value.clientHeight) panel.value.scrollTop = item.offsetTop + item.offsetHeight - panel.value.clientHeight })
function keydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape' && open.value) { event.preventDefault(); event.stopPropagation(); open.value = false; return }
  if (event.key === 'Tab') { open.value = false; return }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); open.value = true
    if (matches.value.length) active.value = active.value < 0 ? (event.key === 'ArrowDown' ? 0 : matches.value.length - 1) : (active.value + (event.key === 'ArrowDown' ? 1 : -1) + matches.value.length) % matches.value.length
    return
  }
  if (event.key === 'Enter' && open.value && active.value >= 0 && matches.value[active.value]) { event.preventDefault(); choose(matches.value[active.value]!); }
}
</script>

<style scoped>
.ui-combobox { position: relative; min-width: 0; }
input { box-sizing: border-box; width: 100%; min-height: 36px; padding: 10px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
ul { position: fixed; z-index: 2000; box-sizing: border-box; max-height: 240px; overflow: auto; overscroll-behavior: contain; list-style: none; margin: 0; padding: 4px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); font: 13px/1.4 Inter, system-ui, sans-serif; box-shadow: 0 12px 36px var(--c-shadow); }
li { min-height: 32px; display: flex; align-items: center; padding: 4px 8px; overflow-wrap: anywhere; cursor: pointer; }
li.active { background: var(--c-selection-bg); color: var(--c-primary); }
@media (max-width: 700px), (pointer: coarse) { input { min-height: 44px; font-size: 16px; } li { min-height: 44px; } }
</style>
