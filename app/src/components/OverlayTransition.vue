<template>
  <Transition name="overlay" appear @before-enter="restore" @before-leave="disable" @leave-cancelled="restore" @after-leave="emit('after-leave')">
    <slot />
  </Transition>
</template>

<script setup lang="ts">
const emit = defineEmits<{ 'after-leave': [] }>()
const leaving = new WeakMap<Element, { inert: boolean; ariaHidden: string | null }>()
function disable(element: Element) {
  if (!(element instanceof HTMLElement)) return
  leaving.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') })
  element.inert = true
  element.setAttribute('aria-hidden', 'true')
}
function restore(element: Element) {
  const previous = leaving.get(element)
  if (!(element instanceof HTMLElement) || !previous) return
  element.inert = previous.inert
  if (previous.ariaHidden === null) element.removeAttribute('aria-hidden')
  else element.setAttribute('aria-hidden', previous.ariaHidden)
  leaving.delete(element)
}
</script>
