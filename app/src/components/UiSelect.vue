<template>
  <span ref="root" class="ui-select" :class="attrs.class" :style="attrs.style as StyleValue"
    :data-disabled="disabled || undefined" :data-open="open || undefined" :data-invalid="invalid || undefined">
    <button ref="trigger" v-bind="triggerAttrs()" class="ui-select-trigger" type="button" role="combobox"
      :data-ui-select-trigger="uid" :disabled="disabled" :aria-expanded="open" aria-haspopup="listbox"
      :aria-controls="open ? listId : undefined" :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined"
      :aria-required="required || undefined" :aria-invalid="invalid || attrs['aria-invalid'] as Booleanish | undefined"
      @click="toggle" @keydown="onKeydown" @blur="onBlur">
      <span class="ui-select-label" :lang="selectedOption?.lang">{{ selectedOption?.text || '\u00a0' }}</span>
      <svg class="ui-select-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" /></svg>
    </button>
    <!-- Only this invisible, inert-to-pointer select participates in native forms. Never invoke showPicker(). -->
    <select ref="native" class="ui-select-native" :name="name" :form="form" :required="required" :disabled="disabled"
      tabindex="-1" aria-hidden="true" @click.prevent @keydown.prevent @focus="trigger?.focus({ preventScroll: true })"
      @invalid="onInvalid" @change="onNativeChange" @input="emit('input', $event)">
      <slot />
    </select>
    <Teleport to="body">
      <div v-if="open" :id="listId" ref="popup" class="ui-select-popup" role="listbox"
        :data-ui-select-owner="uid" data-ui-select-popup :data-placement="placement"
        :aria-label="popupLabel" :aria-labelledby="attrs['aria-labelledby'] as string | undefined"
        :style="position" @pointerdown.stop="onPopupPointerdown" @mousedown.stop.prevent @click.stop @keydown.stop>
        <div v-for="(option, index) in options" :id="optionId(index)" :key="index" role="option"
          class="ui-select-option" :class="{ 'is-active': index === active, 'is-selected': index === selected }"
          :aria-selected="index === selected" :aria-disabled="option.disabled || undefined" :lang="option.lang"
          @pointermove="onOptionPointermove($event, index)" @click.stop="commit(index)">
          <span class="ui-select-option-label">{{ option.text }}</span>
          <svg v-if="index === selected" class="ui-select-check" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.5" /></svg>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onDeactivated, onMounted, onUnmounted, onUpdated, ref, shallowRef, useAttrs, useId, watch, type HTMLAttributes, type StyleValue } from 'vue'
import { findSelectOption, moveSelectOption, selectPopupPosition, selectValueEqual, type SelectOption } from '../select-control.ts'

defineOptions({ inheritAttrs: false })
type Booleanish = boolean | 'true' | 'false'
// Type ordinary HTML fallthrough attributes without turning them into consumed runtime props.
interface SelectProps extends /* @vue-ignore */ HTMLAttributes {
  // Like a native option's Vue _value, values may be strings, numbers or application objects.
  modelValue?: any
  value?: any
  modelModifiers?: { number?: boolean; trim?: boolean }
  disabled?: boolean
  required?: boolean
  name?: string
  form?: string
}
const props = defineProps<SelectProps>()
const emit = defineEmits<{ 'update:modelValue': [value: any]; change: [event: Event]; input: [event: Event]; invalid: [event: Event] }>()
const attrs = useAttrs()
const instance = getCurrentInstance()!
const uid = `ui-select-${useId()}`
const listId = `${uid}-listbox`
const optionId = (index: number) => `${uid}-option-${index}`
const root = ref<HTMLElement>()
const native = ref<HTMLSelectElement>()
const trigger = ref<HTMLButtonElement>()
const popup = ref<HTMLElement>()
const options = shallowRef<SelectOption[]>([])
const selected = ref(-1)
const active = ref(-1)
const open = ref(false)
const invalid = ref(false)
const selectedOption = computed(() => options.value[selected.value])
const position = ref<Record<string, string>>({})
const placement = ref('bottom')
const popupLabel = ref<string>()
let observer: MutationObserver | undefined
let resizeObserver: ResizeObserver | undefined
let resetForm: HTMLFormElement | null = null
let initialValue: unknown
let initialHadSelection = false
let lastExternal: unknown
let initialized = false
let disposed = false
let search = ''
let searchAt = 0
let finePointer: MediaQueryList | undefined

function triggerAttrs() {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
}
function hasModel() { return Object.prototype.hasOwnProperty.call(instance.vnode.props ?? {}, 'modelValue') }
function isControlled() { return hasModel() || Object.prototype.hasOwnProperty.call(instance.vnode.props ?? {}, 'value') }
function externalValue() { return hasModel() ? props.modelValue : props.value }
function rawValue(option: HTMLOptionElement): unknown { return '_value' in option ? (option as HTMLOptionElement & { _value: unknown })._value : option.value }
function isDisabled() { return props.disabled || !!native.value?.matches(':disabled') }

/** Read the rendered slot, not cached VNodes: v-for, translated labels and option property values stay live. */
function syncOptions() {
  const select = native.value
  if (!select || disposed) return
  const next = Array.from(select.options, option => ({
    value: rawValue(option), text: option.label,
    disabled: option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && (option.parentElement as HTMLOptGroupElement).disabled),
    lang: option.lang || option.closest('[lang]')?.getAttribute('lang') || undefined,
  }))
  const changed = next.length !== options.value.length || next.some((option, i) => {
    const previous = options.value[i]!
    return !Object.is(option.value, previous.value) || option.text !== previous.text || option.disabled !== previous.disabled || option.lang !== previous.lang
  })
  if (changed) options.value = next
  const external = externalValue()
  if (isControlled() && (!initialized || changed || !Object.is(external, lastExternal))) {
    select.selectedIndex = next.findIndex(option => selectValueEqual(option.value, external))
  }
  selected.value = select.selectedIndex
  lastExternal = external
  if (!initialized) {
    initialHadSelection = selected.value >= 0
    initialValue = next[selected.value]?.value
    initialized = true
  }
  if (invalid.value) invalid.value = !select.validity.valid
  if (open.value && (active.value < 0 || !next[active.value] || next[active.value]?.disabled)) {
    active.value = preferredActive()
  }
  if (resetForm !== select.form) {
    resetForm?.removeEventListener('reset', onReset)
    resetForm = select.form
    resetForm?.addEventListener('reset', onReset)
  }
  if (open.value && changed) void nextTick(updatePosition)
}
function preferredActive() {
  return selected.value >= 0 && !options.value[selected.value]?.disabled ? selected.value : moveSelectOption(options.value, -1, 1)
}
function modelValueAt(index: number) {
  let value = options.value[index]?.value
  if (props.modelModifiers?.trim && typeof value === 'string') value = value.trim()
  if (props.modelModifiers?.number && typeof value === 'string') {
    const numeric = parseFloat(value)
    if (!Number.isNaN(numeric)) value = numeric
  }
  return value
}
function onNativeChange(event: Event) {
  if (!native.value) return
  selected.value = native.value.selectedIndex
  invalid.value = !native.value.validity.valid
  emit('update:modelValue', modelValueAt(selected.value))
  emit('change', event)
}
function commit(index: number, dismiss = true) {
  if (isDisabled() || index < 0 || options.value[index]?.disabled || !native.value) return
  const changed = native.value.selectedIndex !== index
  native.value.selectedIndex = index
  selected.value = index
  if (changed) {
    // Real DOM events preserve target/currentTarget.value and native form bubbling for legacy @change callers.
    native.value.dispatchEvent(new Event('input', { bubbles: true }))
    native.value.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (dismiss) close(true)
}
function onReset(event: Event) {
  queueMicrotask(() => {
    if (disposed || event.defaultPrevented || !native.value) return
    const index = initialHadSelection ? options.value.findIndex(option => selectValueEqual(option.value, initialValue)) : -1
    native.value.selectedIndex = index
    selected.value = index
    invalid.value = false
    emit('update:modelValue', modelValueAt(index))
    close(false)
  })
}
function onInvalid(event: Event) {
  // A clipped validation anchor cannot display the browser tooltip. Focus the accessible visible control instead.
  event.preventDefault()
  invalid.value = true
  emit('invalid', event)
  trigger.value?.focus({ preventScroll: true })
}

function updatePosition() {
  if (!open.value || !trigger.value || !popup.value || !root.value) return
  if (!root.value.getClientRects().length || isDisabled()) { close(false); return }
  const rect = root.value.getBoundingClientRect()
  const viewport = window.visualViewport
  const bounds = { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }
  if (rect.bottom < bounds.top || rect.top > bounds.top + bounds.height || rect.left > bounds.left + bounds.width || rect.right < bounds.left) { close(false); return }
  const rowHeight = window.matchMedia('(max-width: 700px), (pointer: coarse)').matches ? 44 : 32
  const desiredHeight = Math.min(288, options.value.length * rowHeight + 8)
  const result = selectPopupPosition(rect, bounds, desiredHeight, Math.max(160, Math.min(420, popup.value.scrollWidth)))
  placement.value = result.placement
  position.value = { left: `${result.left}px`, top: `${result.top}px`, width: `${result.width}px`, maxHeight: `${result.maxHeight}px` }
}
function scrollActive() {
  const panel = popup.value
  const item = panel?.querySelector<HTMLElement>(`[id="${optionId(active.value)}"]`)
  if (!panel || !item) return
  // Do not scrollIntoView: that can unexpectedly scroll the ancestor page.
  if (item.offsetTop < panel.scrollTop) panel.scrollTop = item.offsetTop
  else if (item.offsetTop + item.offsetHeight > panel.scrollTop + panel.clientHeight) panel.scrollTop = item.offsetTop + item.offsetHeight - panel.clientHeight
}
function onOutside(event: Event) {
  const path = event.composedPath()
  if (!path.includes(root.value!) && !path.includes(popup.value!)) close(false)
}
function onScroll(event: Event) {
  if (event.target === popup.value) return
  updatePosition()
}
function bindOpenListeners() {
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside, true)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', onScroll, true)
  window.visualViewport?.addEventListener('resize', updatePosition)
  window.visualViewport?.addEventListener('scroll', updatePosition)
  resizeObserver = new ResizeObserver(updatePosition)
  if (root.value) resizeObserver.observe(root.value)
}
function unbindOpenListeners() {
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside, true)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', onScroll, true)
  window.visualViewport?.removeEventListener('resize', updatePosition)
  window.visualViewport?.removeEventListener('scroll', updatePosition)
  resizeObserver?.disconnect()
  resizeObserver = undefined
}
async function show(index = preferredActive()) {
  if (isDisabled() || !options.value.length || open.value) return
  active.value = index
  // Labels remain associated with the visible button. Supply the listbox with the same name.
  popupLabel.value = (attrs['aria-label'] as string | undefined) || Array.from(trigger.value?.labels ?? [], label => label.textContent?.trim()).filter(Boolean).join(' ') || (attrs.title as string | undefined)
  open.value = true
  trigger.value?.focus({ preventScroll: true })
  bindOpenListeners()
  await nextTick()
  updatePosition()
  await nextTick()
  scrollActive()
}
function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  search = ''
  unbindOpenListeners()
  if (restoreFocus && !isDisabled()) trigger.value?.focus({ preventScroll: true })
}
function toggle() { if (open.value) close(); else void show() }
function onBlur(event: FocusEvent) {
  if (!popup.value?.contains(event.relatedTarget as Node | null)) close(false)
}
function onPopupPointerdown(event: PointerEvent) {
  // Preserve focus on the combobox, but do not cancel touch scrolling.
  if (event.pointerType !== 'touch') event.preventDefault()
}
function onOptionPointermove(event: PointerEvent, index: number) {
  if (finePointer?.matches && event.pointerType !== 'touch' && (event.movementX || event.movementY) && !options.value[index]?.disabled) active.value = index
}
function onKeydown(event: KeyboardEvent) {
  if (isDisabled() || event.isComposing || event.ctrlKey || event.metaKey) return
  const key = event.key
  if (key === 'Tab') { if (open.value) { event.stopPropagation(); close(false) }; return }
  if (key === 'Escape') { if (open.value) { event.preventDefault(); event.stopPropagation(); close(true) }; return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    event.preventDefault()
    event.stopPropagation()
    const direction = key === 'ArrowUp' || key === 'End' ? -1 : 1
    const start = key === 'Home' ? -1 : key === 'End' ? 0 : active.value
    if (!open.value) void show(key === 'Home' || key === 'End' ? moveSelectOption(options.value, start, direction) : preferredActive())
    else { active.value = moveSelectOption(options.value, start, direction); void nextTick(scrollActive) }
    return
  }
  if (key === 'Enter' || (key === ' ' && (!search || Date.now() - searchAt > 700))) {
    event.preventDefault()
    event.stopPropagation()
    if (open.value) commit(active.value)
    else void show()
    return
  }
  if (key.length !== 1 || event.altKey) return
  event.preventDefault()
  event.stopPropagation()
  const now = Date.now()
  search = now - searchAt > 700 ? key : search + key
  searchAt = now
  const repeated = Array.from(search).every(character => character.toLocaleLowerCase() === key.toLocaleLowerCase())
  const query = repeated ? key : search
  const current = open.value ? active.value : selected.value
  let match = findSelectOption(options.value, query, query.length > 1 ? current - 1 : current)
  if (match < 0) { search = key; match = findSelectOption(options.value, key, current) }
  if (match < 0) return
  if (open.value) { active.value = match; void nextTick(scrollActive) }
  else commit(match, false)
}
watch(() => props.disabled, disabled => { if (disabled) close(false) })
onMounted(() => {
  syncOptions()
  finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  observer = new MutationObserver(syncOptions)
  if (native.value) observer.observe(native.value, { subtree: true, childList: true, characterData: true, attributes: true })
})
onUpdated(syncOptions)
onDeactivated(() => close(false))
onUnmounted(() => { disposed = true; close(false); observer?.disconnect(); resetForm?.removeEventListener('reset', onReset) })
defineExpose({ focus: () => trigger.value?.focus(), checkValidity: () => native.value?.checkValidity() ?? true, reportValidity: () => native.value?.reportValidity() ?? true, setCustomValidity: (message: string) => { native.value?.setCustomValidity(message); invalid.value = !!message }, native })
</script>

<style scoped>
.ui-select { position: relative; display: inline-flex; vertical-align: middle; align-items: stretch; min-width: 0; max-width: 100%; min-height: 36px; box-sizing: border-box; padding: 5px 9px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; line-height: 1.4; text-align: start; }
.ui-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1; min-width: 0; width: 100%; max-width: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; text-align: inherit; cursor: pointer; outline: none; }
.ui-select-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-select-chevron, .ui-select-check { flex: none; color: var(--c-text-muted); }
.ui-select:has(.ui-select-trigger:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.ui-select[data-open] { border-color: var(--c-blue); }
.ui-select[data-invalid] { border-color: var(--c-error); }
.ui-select[data-disabled] { opacity: .5; }
.ui-select-trigger:disabled { cursor: not-allowed; }
.ui-select-native { position: absolute !important; width: 1px !important; height: 1px !important; min-width: 0 !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; border: 0 !important; opacity: 0 !important; overflow: hidden !important; clip-path: inset(50%) !important; pointer-events: none !important; }
.ui-select-popup { position: fixed; z-index: 2000; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; padding: 3px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 12px 36px var(--c-shadow); font: 13px/1.4 Inter, system-ui, sans-serif; text-align: start; scroll-behavior: auto; }
.ui-select-option { display: flex; align-items: center; gap: 12px; min-height: 32px; box-sizing: border-box; padding: 6px 8px; cursor: pointer; user-select: none; }
.ui-select-option-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ui-select-option.is-selected { color: var(--c-primary); }
.ui-select-option.is-active { background: var(--c-selection-bg); color: var(--c-primary); }
.ui-select-option[aria-disabled='true'] { color: var(--c-text-muted); opacity: .5; cursor: not-allowed; }
.ui-select-check { color: currentColor; }
@media (hover: hover) and (pointer: fine) {
  .ui-select:not([data-disabled]):hover { border-color: var(--c-border-hover); }
  .ui-select-option:not([aria-disabled='true']):hover { background: var(--c-selection-bg); }
}
@media (max-width: 700px), (pointer: coarse) {
  .ui-select { min-height: 44px; font-size: 16px; }
  .ui-select-option { min-height: 44px; }
}
/* High-frequency selection and keyboard navigation are deliberately instant, including reduced motion. */
</style>
