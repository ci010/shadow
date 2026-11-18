<script setup lang="ts">
import type { AnswerData } from '../../../src/shared/answer-data.ts'
defineProps<{ data: AnswerData }>()
</script>

<template>
  <div class="data-scroll">
    <table :aria-label="data.title || undefined">
      <thead><tr><th v-for="(column, i) in data.columns" :key="i" scope="col">{{ column }}</th></tr></thead>
      <tbody><tr v-for="(row, i) in data.rows" :key="i"><td v-for="(cell, j) in row" :key="j">{{ cell == null ? '—' : String(cell) }}</td></tr></tbody>
    </table>
  </div>
</template>

<style scoped>
.data-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--c-border); text-align: start; }
</style>
