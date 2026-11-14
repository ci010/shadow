<template>
  <Teleport v-if="groups && canonical && destination" :to="destination">
    <div v-show="visible" class="editor-view" :data-editor-id="descriptor.id"><slot /></div>
  </Teleport>
  <div v-else-if="!groups" v-show="selected" class="editor-view"><slot /></div>
</template>
<script setup lang="ts">
import { computed, inject, onUnmounted, watch } from 'vue'
import { EditorGroupsKey, type EditorDescriptor, type EditorSide } from '../editor-groups.ts'
const props = withDefaults(defineProps<{ descriptor: EditorDescriptor; selected?: boolean; active?: boolean; initialSide?: EditorSide }>(), { active: true, initialSide: 'left' })
const groups = inject(EditorGroupsKey, undefined)
const token = Symbol('editor-view')
if (groups) groups.registerView(props.descriptor.id, token)
const canonical = computed(() => !groups || groups.views.get(props.descriptor.id)?.[0] === token)
let registered = groups?.descriptors.has(props.descriptor.id) ?? false
watch(() => [props.descriptor, canonical.value] as const, ([descriptor, ownsView]) => {
  if (!groups || !ownsView) return
  if (!registered) { groups.open(descriptor, props.initialSide, false); registered = true }
  else groups.descriptors.set(descriptor.id, descriptor)
}, { immediate: true })
watch(() => props.selected, selected => { if (selected && props.active) groups?.activate(props.descriptor.id) }, { immediate: true })
const visible = computed(() => props.active && !!groups?.visible(props.descriptor.id))
const destination = computed(() => groups?.targets.get(`${props.descriptor.projectId}:${groups.side(props.descriptor.id) ?? 'parking'}`) ?? groups?.targets.get('parking'))
onUnmounted(() => groups?.unregisterView(props.descriptor.id, token))
</script>
<style scoped>
.editor-view { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
</style>
