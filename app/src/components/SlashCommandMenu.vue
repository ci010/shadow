<template>
  <Teleport to="body">
    <OverlayTransition>
    <div v-if="open" class="slash-menu" :style="position" @pointerdown.prevent>
      <div v-if="loading" class="slash-status" role="status">{{ t('Loading commands...') }}</div>
      <div v-else-if="error" class="slash-status" role="alert">
        <span>{{ error }}</span>
        <button type="button" @click="refresh">{{ t('Retry') }}</button>
      </div>
      <div v-else-if="!matches.length" class="slash-status" role="status">{{ t('No matching commands.') }}</div>
      <div :id="listId" class="slash-options" role="listbox" :aria-label="t('Slash commands')" :aria-busy="loading">
        <button v-for="(command, index) in matches" :id="optionId(index)" :key="command.name"
          type="button" role="option" tabindex="-1" :aria-selected="index === selected"
          class="slash-option" @pointermove="selected = index" @click="choose(command)">
          <span class="slash-name">/{{ command.name }}</span>
          <span class="slash-description">{{ command.description }}</span>
        </button>
      </div>
      <div v-if="matches.length" class="slash-keys" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('Navigate') }}</span>
        <span><kbd>Tab</kbd><kbd>Enter</kbd> {{ t('Complete') }}</span>
        <span><kbd>Esc</kbd> {{ t('Close') }}</span>
      </div>
    </div>
    </OverlayTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { filterSlashCommands, slashCommandQuery, useSlashCommandCatalog, type SlashCommand } from '../slash-commands.ts'
import OverlayTransition from './OverlayTransition.vue'

const props = defineProps<{
  apiBase: string
  sessionId: string
  text: string
  input?: HTMLTextAreaElement
  focused: boolean
  active: boolean
  selectionStart: number
  selectionEnd: number
}>()
const emit = defineEmits<{ complete: [text: string] }>()
const listId = `slash-${useId()}`
const optionId = (index: number) => `${listId}-${index}`
const query = computed(() => slashCommandQuery(props.text, props.selectionStart, props.selectionEnd))
const dismissed = ref(false)
const selected = ref(0)
const open = computed(() => props.active && props.focused && query.value !== null && !dismissed.value)
const { commands, loading, error, refresh } = useSlashCommandCatalog(() => ({
  apiBase: props.apiBase, sessionId: props.sessionId, enabled: open.value,
}))
const matches = computed(() => filterSlashCommands(commands.value, query.value ?? ''))
const activeId = computed(() => open.value && matches.value[selected.value] ? optionId(selected.value) : undefined)
const position = ref<Record<string, string>>({})

watch(() => [props.text, props.apiBase, props.sessionId], () => { dismissed.value = false; selected.value = 0 }, { flush: 'sync' })
watch(matches, () => { selected.value = 0 })
watch(activeId, async id => {
  await nextTick()
  if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' })
})
function place() {
  const anchor = props.input?.closest('.composer-box') ?? props.input
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0
  const height = viewport?.height ?? window.innerHeight
  const above = rect.top - top - 20
  const below = top + height - rect.bottom - 20
  const upward = above >= Math.min(160, below)
  position.value = {
    width: `${Math.min(rect.width, window.innerWidth - 24)}px`,
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12))}px`,
    ...(upward ? { bottom: `${window.innerHeight - rect.top + 8}px` } : { top: `${rect.bottom + 8}px` }),
    maxHeight: `${Math.max(80, Math.min(340, upward ? above : below))}px`,
  }
}
function listen(enabled: boolean) {
  if (enabled) {
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
  } else {
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, true)
    window.visualViewport?.removeEventListener('resize', place)
    window.visualViewport?.removeEventListener('scroll', place)
  }
}
watch(open, value => { listen(value); if (value) place() }, { flush: 'post' })
onUnmounted(() => listen(false))
function choose(command: SlashCommand) {
  dismissed.value = true
  emit('complete', `${props.text.match(/^[ \t]*/)?.[0] ?? ''}/${command.name} `)
}
function handleKeyDown(event: KeyboardEvent): boolean {
  if (!open.value || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key === 'Escape') dismissed.value = true
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (event.shiftKey) return false
    if (matches.value.length) selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + matches.value.length) % matches.value.length
  } else if (!event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
    const command = matches.value[selected.value]
    if (command) choose(command)
    else if (!loading.value || event.key === 'Tab') return false
  } else return false
  event.preventDefault()
  event.stopPropagation()
  return true
}
defineExpose({ open, activeId, listId, handleKeyDown })
</script>

<style scoped>
.slash-menu { position: fixed; z-index: 940; display: flex; flex-direction: column; box-sizing: border-box; padding: 5px; border: 1px solid var(--c-border-hover); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 8px 24px var(--c-shadow); }
.slash-options { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.slash-option { display: flex; align-items: baseline; gap: 12px; width: 100%; min-height: 42px; padding: 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.slash-option[aria-selected="true"] { background: var(--c-bg-muted); outline: 1px solid var(--c-border-hover); outline-offset: -1px; }
.slash-name { flex: 0 0 auto; font-weight: 650; }
.slash-description { min-width: 0; color: var(--c-text-secondary); overflow-wrap: anywhere; line-height: 1.45; }
.slash-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; color: var(--c-text-secondary); font-size: 13px; }
.slash-status button { padding: 5px 10px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
.slash-keys { display: flex; flex-wrap: wrap; gap: 14px; padding: 9px 10px 4px; border-top: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 11px; }
.slash-keys span { display: inline-flex; align-items: center; gap: 4px; }
.slash-keys kbd { font: inherit; }
@media (max-width: 540px) { .slash-option { flex-direction: column; align-items: flex-start; gap: 3px; min-height: 44px; } .slash-keys { display: none; } }
</style>
