<script setup lang="ts">defineProps<{ animating?: boolean }>()</script>
<template><figure class="alignment-preview" :class="{ animating }"><slot /></figure></template>
<style scoped>
.alignment-preview{margin:0;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--c-bg-muted);aspect-ratio:16/9}
.alignment-preview :deep(img),.alignment-preview :deep(video){max-height:100%;width:100%;object-fit:contain;min-height:0}
.animating :deep(img){animation:preview-drift 5s linear infinite alternate}@keyframes preview-drift{to{transform:scale(1.09)}}@media(prefers-reduced-motion:reduce){.animating :deep(img){animation:none}}
</style>
