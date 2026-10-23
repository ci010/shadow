<template>
  <div
    ref="container"
    class="log-virtual"
    :style="{ height: `${height}px` }"
    @scroll="handleScroll"
  >
    <div class="log-virtual-spacer" :style="{ height: `${totalHeight}px` }">
      <div class="log-virtual-window" :style="{ transform: `translateY(${offset}px)` }">
        <button
          v-for="entry in visibleEntries"
          :key="entry.id"
          class="log-item"
          :class="{ active: entry.id === selectedId, trace: entry.kind === 'trace' }"
          type="button"
          @click="emit('select', entry)"
        >
          <div class="log-item-main">
            <span class="log-time">{{ entry.time ?? '--:--:--' }}</span>
            <span class="log-module">{{ entry.module ?? t('system') }}</span>
            <span class="log-summary">{{ entry.summary }}</span>
          </div>
          <span class="log-tag" :class="entry.kind">{{ entry.kind === 'trace' ? t('trace') : t('log') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, ref } from 'vue'

export type LogEntry = {
  id: string
  dbId?: number // Database ID for cursor-based pagination
  raw: string
  parsed?: Record<string, unknown>
  level?: number
  msg?: string
  time?: string
  module?: string
  kind: 'trace' | 'log'
  summary: string
}

const props = defineProps<{ entries: LogEntry[]; selectedId?: string; height?: number; rowHeight?: number }>()
const emit = defineEmits<{ (e: 'select', entry: LogEntry): void; (e: 'load-more'): void }>()

const container = ref<HTMLDivElement | null>(null)
const scrollTop = ref(0)

const height = computed(() => props.height ?? 320)
const rowHeight = computed(() => props.rowHeight ?? 56)
const overscan = 6

const totalHeight = computed(() => props.entries.length * rowHeight.value)
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - overscan))
const endIndex = computed(() => Math.min(props.entries.length, Math.ceil((scrollTop.value + height.value) / rowHeight.value) + overscan))
const offset = computed(() => startIndex.value * rowHeight.value)
const visibleEntries = computed(() => props.entries.slice(startIndex.value, endIndex.value))

function handleScroll(): void {
  if (!container.value) return
  scrollTop.value = container.value.scrollTop

  // Emit load-more when scrolled near the bottom (within 100px)
  const scrollBottom = container.value.scrollTop + container.value.clientHeight
  const nearBottom = scrollBottom >= totalHeight.value - 100
  if (nearBottom) {
    emit('load-more')
  }
}
</script>

<style scoped>
.log-virtual {
  overflow: auto;
  position: relative;
}

.log-virtual-spacer {
  position: relative;
  width: 100%;
}

.log-virtual-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  gap: 0.35rem;
  padding: 0.4rem;
}

.log-item {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg-card);
  padding: 0.5rem 0.7rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  transition: border-color 0.1s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.15s ease;
}

.log-item:hover {
  border-color: var(--c-border-hover);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px var(--c-shadow-softer);
}

.log-item.active {
  border-color: var(--c-text);
  background: var(--c-bg-soft);
}

.log-item.trace {
  background: var(--c-bg-soft);
  border-left: 3px solid var(--c-gradient-start);
}

.log-item-main {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.log-time {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  color: var(--c-text-muted);
}

.log-module {
  font-weight: 700;
  font-size: 0.85rem;
}

.log-summary {
  font-size: 0.85rem;
  color: var(--c-text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-tag {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--c-border);
  flex-shrink: 0;
  margin-left: 0.5rem;
  color: var(--c-text-body);
}

.log-tag.trace {
  background: var(--c-primary-bg);
  color: var(--c-text-on-primary);
  border-color: transparent;
}
</style>
