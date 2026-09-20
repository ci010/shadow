<template>
  <component :is="as" class="tree-item" :class="{ selected, 'icon-only': iconOnly }" :style="{ '--tree-depth': depth }" @contextmenu="$emit('contextmenu', $event)">
    <template v-if="separateToggle">
      <button v-if="expanded !== undefined" type="button" class="tree-toggle" :class="toggleClass"
        :aria-expanded="expanded" :aria-label="toggleLabel" @click="$emit('toggle')">
        <span class="tree-caret i-lucide-chevron-right" :class="{ open: expanded }" aria-hidden="true" />
      </button>
      <span v-else class="tree-toggle-spacer" aria-hidden="true" />
    </template>
    <HoverInfo :text="title ?? label" :label="label" :interactive="!!$slots.info" :disabled="infoDisabled">
      <template #default="{ triggerProps, close }">
    <button type="button" class="tree-select" :class="buttonClass" v-bind="{ ...buttonAttrs, ...triggerProps }"
      :aria-label="ariaLabel ?? (iconOnly ? label : undefined)" :aria-current="current"
      :aria-expanded="!separateToggle && expanded !== undefined ? expanded : triggerProps['aria-expanded']" @click="selectRow($event, close)">
      <span v-if="!separateToggle" class="tree-toggle-spacer" aria-hidden="true">
        <span v-if="expanded !== undefined" class="tree-caret i-lucide-chevron-right" :class="{ open: expanded }" />
      </span>
      <span v-if="$slots.icon" class="tree-icon" aria-hidden="true"><slot name="icon" /></span>
      <span class="tree-label"><slot>{{ label }}</slot></span>
      <span v-if="$slots.meta && !separateToggle" class="tree-meta"><slot name="meta" /></span>
    </button>
      </template>
      <template #content="{ close }"><slot name="info" :close="close"><span class="tree-info-text">{{ title ?? label }}</span></slot></template>
    </HoverInfo>
    <span v-if="$slots.meta && separateToggle" class="tree-meta"><slot name="meta" /></span>
    <span v-if="$slots.actions" class="tree-actions"><slot name="actions" /></span>
  </component>
</template>

<script setup lang="ts">
import HoverInfo from './HoverInfo.vue'
const props = withDefaults(defineProps<{
  as?: 'div' | 'li'
  label: string
  title?: string
  ariaLabel?: string
  current?: 'page'
  depth?: number
  selected?: boolean
  expanded?: boolean
  separateToggle?: boolean
  toggleLabel?: string
  buttonClass?: string
  toggleClass?: string
  buttonAttrs?: Record<string, string | number | boolean | undefined>
  iconOnly?: boolean
  infoDisabled?: boolean
}>(), { as: 'div', depth: 0, expanded: undefined })
const emit = defineEmits<{ select: []; toggle: []; contextmenu: [event: MouseEvent] }>()
function selectRow(event: MouseEvent, close: () => void) {
  if (!props.iconOnly) {
    event.stopPropagation()
    close()
  }
  emit('select')
}
</script>

<style scoped>
.tree-item { display: flex; align-items: center; gap: var(--tree-gap, 6px); min-width: 0; min-height: var(--tree-row-height, 34px); padding: 0 var(--tree-row-inset, 6px) 0 calc(var(--tree-depth) * var(--tree-indent, 12px) + var(--tree-row-inset, 6px)); border-radius: var(--radius-control); color: var(--c-text); }
.tree-item:hover { background: var(--c-bg-muted); }
.tree-item.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.tree-item.selected .tree-icon { color: var(--c-primary); }
.tree-item:has(.tree-select:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.tree-select { display: flex; align-items: center; gap: var(--tree-icon-gap, 6px); flex: 1; min-width: 0; min-height: var(--tree-row-height, 34px); padding: 2px 0; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; user-select: none; outline: none; }
.tree-toggle, .tree-toggle-spacer { display: grid; place-items: center; flex: 0 0 var(--tree-disclosure, 20px); width: var(--tree-disclosure, 20px); height: var(--tree-row-height, 28px); }
.tree-select > .tree-toggle-spacer { height: calc(var(--tree-row-height, 32px) - 4px); margin-inline-end: calc(var(--tree-gap, 6px) - var(--tree-icon-gap, 6px)); }
.tree-toggle { padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; cursor: pointer; }
.tree-toggle:hover { background: var(--c-bg-soft); }
.tree-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.tree-caret { display: block; width: 12px; height: 12px; color: var(--c-text-secondary); }
.tree-caret.open { transform: rotate(90deg); }
.tree-icon { display: grid; place-items: center; flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-secondary); }
.tree-icon :deep(> *) { display: block; width: 16px; height: 16px; }
.tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-meta { display: flex; align-items: center; flex-shrink: 0; font-size: 11px; color: var(--c-text-faint); }
.tree-actions { display: flex; align-items: center; flex-shrink: 0; }
.tree-info-text { white-space: pre-line; }
.tree-item.icon-only { position: relative; width: 44px; min-height: 44px; margin-inline: auto; padding: 0; border-radius: var(--radius-control); }
.icon-only .tree-select { justify-content: center; min-height: 44px; padding: 0; }
.icon-only .tree-toggle, .icon-only .tree-toggle-spacer, .icon-only .tree-label, .icon-only .tree-actions { display: none; }
.icon-only .tree-icon { flex-basis: 20px; width: 20px; height: 20px; color: inherit; }
.icon-only .tree-icon :deep(> *) { width: 20px; height: 20px; }
.icon-only .tree-meta { position: absolute; right: -2px; bottom: -2px; pointer-events: none; }
</style>
