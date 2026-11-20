<template><div ref="dock" class="model-outline-dock" /></template>
<script setup lang="ts">
import { inject, ref, watchEffect } from 'vue'
import { modelOutlineTarget } from '../../model-outline-host.ts'
import { EditorGroupsKey } from '../../editor-groups.ts'
const props = defineProps<{ projectId: string }>()
const groups = inject(EditorGroupsKey)!
const dock = ref<HTMLElement>()
watchEffect(cleanup => {
  const el = dock.value, id = modelOutlineTarget(props.projectId)
  if (!el) return
  groups.targets.set(id, el)
  cleanup(() => { if (groups.targets.get(id) === el) groups.targets.delete(id) })
})
</script>
<style scoped>
.model-outline-dock { display: flex; flex-direction: column; min-height: 0; min-width: 0; flex: 1 1 0; overflow: hidden; border-top: 1px solid var(--c-border); }
.model-outline-dock:not(:has(> section)) { display: none; }
</style>
