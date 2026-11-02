<script setup lang="ts">
import './alignment-controls.css'
defineProps<{ label?: string }>()
</script>
<template><div class="alignment-toolbar" role="group" :aria-label="label"><slot /></div></template>
<style scoped>.alignment-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}</style>
