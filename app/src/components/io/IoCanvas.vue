<template><canvas ref="canvas" width="640" height="360" role="img" :aria-label="node.text || 'Generated drawing'">{{ node.text || 'Generated drawing' }}</canvas></template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { IoUiNode } from '../../../../src/io/contracts.ts'
const props = defineProps<{ node: IoUiNode }>()
const canvas = ref<HTMLCanvasElement>()
watch([canvas, () => props.node], () => {
  const context = canvas.value?.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, 640, 360)
  for (const command of props.node.commands ?? []) {
    context.strokeStyle = command.color ?? '#777777'
    context.fillStyle = command.color ?? '#777777'
    context.font = '16px system-ui'
    if (command.op === 'clear') context.clearRect(0, 0, 640, 360)
    if (command.op === 'rect') context.fillRect(command.x, command.y, command.x2 ?? 0, command.y2 ?? 0)
    if (command.op === 'text') context.fillText(command.text ?? '', command.x, command.y, 640)
    if (command.op === 'line') {
      context.beginPath(); context.moveTo(command.x, command.y); context.lineTo(command.x2 ?? command.x, command.y2 ?? command.y); context.stroke()
    }
  }
}, { flush: 'post', deep: true })
</script>
<style scoped>canvas { width: 100%; height: auto; background: var(--c-bg-input); border: 1px solid var(--c-border); }</style>
