<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
defineProps<{ data: { owner: string; width: number; height: number; ports: { id: string; type: 'source' | 'target'; title: string }[] } }>()
</script>
<template><div class="region" :data-region-owner="data.owner" :style="{ width: `${data.width}px`, height: `${data.height}px` }">
<Handle id="ownership" type="target" :position="Position.Top" :connectable="false" />
<template v-for="(port,index) in data.ports" :key="port.id"><span class="port-evidence" :style="{ top: `${100 * (index + 1) / (data.ports.length + 1)}%`, left: port.type === 'target' ? '-8px' : undefined, right: port.type === 'source' ? '-8px' : undefined }" :title="port.title" :aria-label="port.title" tabindex="0" />
<Handle :id="port.id" :type="port.type" :position="port.type === 'source' ? Position.Right : Position.Left" :connectable="false" :style="{ top: `${100 * (index + 1) / (data.ports.length + 1)}%` }" /></template>
</div></template>
<style scoped>.region { box-sizing:border-box;border:2px dashed var(--c-text-muted);border-radius:24px;background:color-mix(in srgb,var(--c-blue) 4%,transparent);pointer-events:none; }.port-evidence { position:absolute;width:16px;height:12px;pointer-events:auto;z-index:3; }.port-evidence:focus-visible { outline:2px solid var(--c-blue); }:deep(.vue-flow__handle) { width:7px;height:7px;background:var(--c-text-muted);pointer-events:none; }</style>
