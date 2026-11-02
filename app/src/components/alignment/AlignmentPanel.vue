<script setup lang="ts">
import './alignment-controls.css'
defineProps<{ title?: string }>()
</script>
<template>
  <section class="alignment-surface"><header v-if="title || $slots.actions" class="panel-header"><h2 v-if="title">{{ title }}</h2><slot name="actions" /></header><slot /></section>
</template>
<style scoped>
.alignment-surface{min-width:0;box-sizing:border-box;border:1px solid var(--c-border);padding:16px;background:var(--c-bg-card);color:var(--c-text);container-type:inline-size}
.panel-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}h2{font-size:15px;line-height:20px;font-weight:600;margin:0;overflow-wrap:anywhere}
</style>
