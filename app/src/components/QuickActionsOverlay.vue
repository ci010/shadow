<template><div ref="root" class="actions-overlay"><QuickActions ref="actions" :api-base="apiBase" :project-id="projectId" :active="active" :can-write="canWrite" @close="emit('close')" /></div></template>
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import QuickActions from './QuickActions.vue'
defineProps<{ apiBase: string; projectId: string; active: boolean; canWrite: boolean }>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement>(), actions = ref<InstanceType<typeof QuickActions>>()
function outside(event: PointerEvent) { if (event.target instanceof Node && !root.value?.contains(event.target) && !(event.target instanceof Element && event.target.closest('[data-actions-trigger]'))) emit('close') }
onMounted(async () => { document.addEventListener('pointerdown', outside); await nextTick(); actions.value?.focus() })
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>
<style scoped>.actions-overlay { position: absolute; top: 44px; right: 8px; left: 8px; z-index: 21; max-height: calc(100% - 56px); overflow: auto; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-control); box-shadow: 0 8px 24px #0003; }</style>
