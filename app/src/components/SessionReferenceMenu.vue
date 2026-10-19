<template>
  <Teleport to="body">
    <OverlayTransition>
    <div v-if="open" class="session-reference-menu" :style="position" @pointerdown.prevent>
      <div v-if="!matches.length" class="session-ref-status" role="status">{{ t('No matching conversations.') }}</div>
      <div :id="listId" class="session-ref-options" role="listbox" :aria-label="t('Reference a conversation')">
        <button v-for="(command, index) in matches" :id="optionId(index)" :key="command.sessionId"
          type="button" role="option" tabindex="-1" :aria-selected="index === selected"
          class="session-ref-option" @pointermove="selected = index" @click="choose(command)">
          <span class="session-ref-name">{{ referenceSessionTitle(command) }}</span>
        </button>
      </div>
      <div v-if="matches.length" class="session-ref-keys" aria-hidden="true">
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
import { referenceSessionTitle, filterReferenceSessions, sessionReferenceQuery, insertSessionReference, type ReferenceSession } from '../session-references.ts'
import OverlayTransition from './OverlayTransition.vue'

const props = defineProps<{
  projectId: string
  sessions: ReferenceSession[]
  sessionId: string
  text: string
  input?: HTMLTextAreaElement
  focused: boolean
  active: boolean
  selectionStart: number
  selectionEnd: number
}>()
const emit = defineEmits<{ complete: [text: string, caret: number] }>()
const listId = `session-ref-${useId()}`
const optionId = (index: number) => `${listId}-${index}`
const query = computed(() => sessionReferenceQuery(props.text, props.selectionStart, props.selectionEnd))
const dismissed = ref(false)
const selected = ref(0)
const open = computed(() => props.active && props.focused && query.value !== null && !dismissed.value)
const matches = computed(() => filterReferenceSessions(props.sessions, props.sessionId, query.value?.query ?? ''))
const activeId = computed(() => open.value && matches.value[selected.value] ? optionId(selected.value) : undefined)
const position = ref<Record<string, string>>({})

watch(() => [props.text, props.projectId, props.sessionId], () => { dismissed.value = false; selected.value = 0 }, { flush: 'sync' })
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
    width: `${Math.min(480, rect.width, window.innerWidth - 24)}px`,
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
watch([open, () => props.input], ([value]) => { listen(value); if (value) place() }, { flush: 'post', immediate: true })
onUnmounted(() => listen(false))
function choose(session: ReferenceSession) {
  if (!query.value) return
  const result = insertSessionReference(props.text, query.value, session, props.projectId)
  emit('complete', result.text, result.caret)
  dismissed.value = true
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
    else return false
  } else return false
  event.preventDefault()
  event.stopPropagation()
  return true
}
defineExpose({ open, activeId, listId, handleKeyDown })
</script>

<style scoped>
.session-reference-menu { position: fixed; z-index: 940; display: flex; flex-direction: column; overflow: hidden; min-width: 0; max-width: min(480px, calc(100vw - 24px)); max-height: 340px; box-sizing: border-box; padding: 5px; border: 1px solid var(--c-border-hover); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 8px 24px var(--c-shadow); }
.session-ref-options { flex: 0 1 auto; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.session-ref-option { appearance: none; box-sizing: border-box; display: flex; align-items: center; flex: none; min-width: 0; max-width: 100%; width: 100%; min-height: 36px; padding: 8px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.session-ref-option[aria-selected="true"] { background: var(--c-bg-muted); outline: 1px solid var(--c-border-hover); outline-offset: -1px; }
.session-ref-name { flex: 1 1 0%; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.session-ref-description { min-width: 0; color: var(--c-text-secondary); overflow-wrap: anywhere; line-height: 1.45; }
.session-ref-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; color: var(--c-text-secondary); font-size: 13px; }
.session-ref-status button { padding: 5px 10px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
.session-ref-keys { flex: none; display: flex; flex-wrap: wrap; gap: 14px; padding: 9px 10px 4px; border-top: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 11px; }
.session-ref-keys span { display: inline-flex; align-items: center; gap: 4px; }
.session-ref-keys kbd { font: inherit; }
@media (max-width: 540px) { .session-ref-option { min-height: 40px; } .session-ref-keys { display: none; } }
</style>
