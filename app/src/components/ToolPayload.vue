<template>
  <div class="tool-payload">
    <pre class="payload-source"><FileHighlightText v-if="path === 'payload.json'" ref="highlight" :source="source" :path="path" :active="true" @error="error = $event" /><template v-else>{{ source }}</template></pre>
    <p v-if="error" class="payload-error" role="status">{{ error }} <button type="button" class="btn btn-sm" @click="highlight?.retry()">Retry</button></p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toolPayloadPath } from '../tool-activity.ts'
import FileHighlightText from './files/FileHighlightText.vue'

const props = defineProps<{ source: string }>()
const path = computed(() => toolPayloadPath(props.source))
const highlight = ref<InstanceType<typeof FileHighlightText>>()
const error = ref('')
watch(() => props.source, () => { error.value = '' }, { flush: 'sync' })
</script>

<style scoped>
.payload-source { margin: 0; white-space: inherit; overflow-wrap: inherit; font: inherit; }
.payload-error { margin: 8px 0 0; white-space: normal; color: var(--c-error); font: 12px/1.5 system-ui, sans-serif; }
</style>
