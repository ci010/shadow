<template>
  <div v-if="open" ref="searchRoot" class="conversation-search" role="search" :aria-label="t('Search conversation')" :aria-busy="loading || navigating" @keydown="searchKey">
    <div class="search-controls">
      <div class="search-field">
      <span class="i-lucide-search search-icon" aria-hidden="true" />
      <input ref="input" v-model="query" type="search" :aria-label="t('Search all conversation history')" :placeholder="t('Search all messages')"
        autocomplete="off" spellcheck="false" @compositionstart="composing = true" @compositionend="endComposition" />
      <span class="search-count" role="status" aria-live="polite" aria-atomic="true">
        <span v-if="loading || navigating" class="i-lucide-loader-circle search-spinner" aria-hidden="true" />
        <span v-if="loading" class="sr-only">{{ t('Loading history...') }}</span>
        <template v-else-if="query.trim()">{{ matches.length ? selected + 1 : 0 }} / {{ matches.length }}</template>
      </span>
      </div>
      <div class="search-actions">
        <HoverInfo :text="t('Previous match (Shift+Enter)')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" :disabled="!matches.length || loading || navigating" :aria-label="t('Previous match')" @click="move(-1)"><span class="i-lucide-chevron-up" aria-hidden="true" /></button>
        </HoverInfo>
        <HoverInfo :text="t('Next match (Enter)')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" :disabled="!matches.length || loading || navigating" :aria-label="t('Next match')" @click="move(1)"><span class="i-lucide-chevron-down" aria-hidden="true" /></button>
        </HoverInfo>
        <HoverInfo class="search-close" :text="t('Close search (Esc)')" v-slot="{ triggerProps }">
          <button v-bind="triggerProps" type="button" :aria-label="t('Close conversation search')" @click="close(true)"><span class="i-lucide-x" aria-hidden="true" /></button>
        </HoverInfo>
      </div>
    </div>
    <p v-if="error" class="search-error" role="alert">{{ error }} <button type="button" @click="load">{{ t('Retry') }}</button></p>
    <p v-else class="search-scope">{{ query.trim() && !loading && !matches.length ? t('No matching messages in this conversation.') : t('All history · message text · Enter / Shift+Enter to navigate') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { conversationMatches, isConversationFindKey, type ConversationSearchEntry, type ConversationSearchMatch } from '../conversation-search.ts'

const props = defineProps<{
  active: boolean
  keyboardActive: boolean
  contextKey: string
  container?: HTMLElement
  liveEntries?: ConversationSearchEntry[]
  loadEntries: (signal: AbortSignal) => Promise<ConversationSearchEntry[]>
  revealMatch: (match: ConversationSearchMatch, query: string, signal: AbortSignal) => Promise<void>
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'query-change': [] }>()
const open = ref(false)
const query = ref('')
const entries = shallowRef<ConversationSearchEntry[]>([])
const matches = computed(() => conversationMatches(entries.value, query.value))
const selected = ref(0)
const input = ref<HTMLInputElement>()
const searchRoot = ref<HTMLElement>()
const loading = ref(false)
const historyReady = ref(false)
const navigating = ref(false)
const error = ref('')
const composing = ref(false)
let returnFocus: HTMLElement | undefined
let returnFocusId: string | undefined
let request: AbortController | undefined
let navigation: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined

async function load() {
  request?.abort()
  navigation?.abort()
  const controller = new AbortController()
  request = controller
  entries.value = []
  selected.value = 0
  historyReady.value = false
  loading.value = true
  error.value = ''
  try {
    const result = await props.loadEntries(controller.signal)
    if (controller.signal.aborted) return
    entries.value = result
    historyReady.value = true
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not search conversation history. Retry.')
  } finally {
    if (request === controller) { loading.value = false; request = undefined }
  }
}

async function show() {
  if (!props.active) return
  if (!open.value) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    returnFocusId = returnFocus?.id || undefined
    open.value = true
    emit('update:open', true)
    void load()
  }
  await nextTick()
  input.value?.focus({ preventScroll: true })
  input.value?.select()
}

function close(restoreFocus = false) {
  request?.abort()
  navigation?.abort()
  clearTimeout(timer)
  request = undefined
  navigation = undefined
  loading.value = false
  historyReady.value = false
  navigating.value = false
  open.value = false
  entries.value = []
  query.value = ''
  error.value = ''
  composing.value = false
  emit('update:open', false)
  const target = returnFocus?.isConnected ? returnFocus : returnFocusId ? document.getElementById(returnFocusId) : undefined
  if (restoreFocus && target?.getClientRects().length) target.focus({ preventScroll: true })
  else if (restoreFocus) props.container?.focus({ preventScroll: true })
}

async function reveal() {
  navigation?.abort()
  const match = matches.value[selected.value]
  if (!open.value || loading.value || !match) return
  const controller = new AbortController()
  navigation = controller
  navigating.value = true
  error.value = ''
  try {
    await props.revealMatch(match, query.value, controller.signal)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not open this search match. Retry.')
  } finally {
    if (navigation === controller) { navigating.value = false; navigation = undefined }
  }
}

function move(direction: number) {
  if (!matches.value.length || loading.value || navigating.value) return
  clearTimeout(timer)
  selected.value = (selected.value + direction + matches.value.length) % matches.value.length
  void reveal()
}

function schedule() {
  if (!open.value) return
  navigation?.abort()
  if (historyReady.value) error.value = ''
  emit('query-change')
  clearTimeout(timer)
  selected.value = 0
  if (!composing.value && !loading.value) timer = setTimeout(() => { void reveal() }, 150)
}
function endComposition() { composing.value = false; schedule() }
function searchKey(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  else if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
}
function documentKey(event: KeyboardEvent) {
  if (event.defaultPrevented || !props.active || !props.keyboardActive || !props.container?.getClientRects().length) return
  const overlay = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], dialog[open], [popover]:popover-open'))
    .some(element => element.getClientRects().length && (!element.classList.contains('hover-info-popup') || element.contains(document.activeElement)))
  if (overlay) return
  if (isConversationFindKey(event)) {
    event.preventDefault()
    event.stopPropagation()
    void show()
  } else if (open.value && event.key === 'Escape' && !event.isComposing && !composing.value && event.keyCode !== 229) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}
watch(query, schedule)
watch(() => props.liveEntries, value => {
  if (open.value && historyReady.value && !loading.value && value) {
    entries.value = [...entries.value.filter(entry => entry.segmentId !== null), ...value]
    selected.value = Math.min(selected.value, Math.max(0, matches.value.length - 1))
  }
})
watch(loading, value => { if (!value && !error.value) schedule() })
watch(() => props.active, value => { if (!value) close() })
watch(() => props.contextKey, () => close())
function outside(event: PointerEvent) { if (open.value && event.target instanceof Node && !searchRoot.value?.contains(event.target)) close(true) }
onMounted(() => { document.addEventListener('keydown', documentKey); document.addEventListener('pointerdown', outside) })
onUnmounted(() => { document.removeEventListener('keydown', documentKey); document.removeEventListener('pointerdown', outside); close() })
defineExpose({ show, close })
</script>

<style scoped>
.conversation-search { position: absolute; top: 44px; right: 12px; width: min(560px, calc(100% - 24px)); box-sizing: border-box; z-index: 20; min-width: 0; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); box-shadow: 0 8px 24px var(--c-shadow-soft); background: var(--c-bg-card); color: var(--c-text); container-type: inline-size; }
.search-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
.search-field { display: flex; align-items: center; flex: 1; min-width: 0; gap: 8px; padding: 0 10px; border: 1px solid var(--c-control-border); background: var(--c-bg-input); transition: border-color .15s ease; }
.search-field:focus-within { border-color: var(--c-blue); outline: 1px solid var(--c-blue); outline-offset: -1px; }
.search-icon { flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-muted); }
input { flex: 1; width: 0; min-width: 0; min-height: 36px; box-sizing: border-box; padding: 7px 0; border: 0; border-radius: var(--radius-control); outline: none; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; }
input::-webkit-search-cancel-button { display: none; }
input::placeholder { color: var(--c-text-muted); }
.search-count { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--c-text-secondary); }
.search-spinner { width: 14px; height: 14px; animation: search-spin .8s linear infinite; }
.search-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.search-close { margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--c-border); }
button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; transition: background-color .14s ease, color .14s ease; }
button span { width: 16px; height: 16px; }
button:hover:not(:disabled) { color: var(--c-text); background: var(--c-bg-muted); }
button:disabled { opacity: .4; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.search-scope, .search-error { margin: 8px 2px 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.search-scope { color: var(--c-text-muted); }
.search-error { color: var(--c-error); }
.search-error button { width: auto; height: auto; min-height: 32px; padding: 0 6px; color: inherit; text-decoration: underline; font: inherit; }
@keyframes search-spin { to { transform: rotate(360deg); } }
@container (max-width: 380px) {
  .search-controls { flex-wrap: wrap; gap: 6px; }
  .search-field { flex-basis: 100%; }
  .search-actions { margin-left: auto; }
}
@media (max-width: 700px), (pointer: coarse) {
  input { min-height: 44px; font-size: 16px; }
  button { width: 44px; height: 44px; }
  .search-error button { width: auto; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .search-spinner { animation: none; }
  .search-field, button { transition: none; }
}
</style>

<style>
::highlight(shadow-conversation-matches) { background-color: var(--c-warn-bg); color: var(--c-warn); text-decoration: underline; }
::highlight(shadow-conversation-active) { background-color: var(--c-primary-bg); color: var(--c-text-on-primary); text-decoration: underline; }
</style>
