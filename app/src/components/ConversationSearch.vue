<template>
  <div v-if="open" ref="searchRoot" class="conversation-search" role="search" :aria-label="t('Search conversation')" :aria-busy="loading || navigating" @keydown="searchKey">
    <div class="search-controls">
      <span class="i-lucide-search search-icon" aria-hidden="true" />
      <input ref="input" v-model="query" type="search" :aria-label="t('Search all conversation history')" :placeholder="t('Search all messages')"
        autocomplete="off" spellcheck="false" @compositionstart="composing = true" @compositionend="endComposition" />
      <span class="search-count" role="status" aria-live="polite" aria-atomic="true">{{ loading ? t('Loading history...') : query.trim() ? `${matches.length ? selected + 1 : 0} / ${matches.length}` : '' }}</span>
      <button type="button" :disabled="!matches.length || loading || navigating" :aria-label="t('Previous match')" :title="t('Previous match (Shift+Enter)')" @click="move(-1)"><span class="i-lucide-chevron-up" aria-hidden="true" /></button>
      <button type="button" :disabled="!matches.length || loading || navigating" :aria-label="t('Next match')" :title="t('Next match (Enter)')" @click="move(1)"><span class="i-lucide-chevron-down" aria-hidden="true" /></button>
      <button type="button" :aria-label="t('Close conversation search')" :title="t('Close search (Esc)')" @click="close(true)"><span class="i-lucide-x" aria-hidden="true" /></button>
    </div>
    <p v-if="error" class="search-error" role="alert">{{ error }} <button type="button" @click="load">{{ t('Retry') }}</button></p>
    <p v-else class="search-scope">{{ query.trim() && !loading && !matches.length ? t('No matching messages in this conversation.') : t('All history · message text · Enter / Shift+Enter to navigate') }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
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
.conversation-search { position: absolute; top: 44px; left: 8px; right: 8px; z-index: 20; border: 1px solid var(--c-border); border-radius: var(--radius-control); box-shadow: 0 8px 24px #0003; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-soft); color: var(--c-text); container-type: inline-size; }
.search-controls { display: flex; align-items: center; gap: 4px; min-width: 0; }
.search-icon { flex: 0 0 16px; width: 16px; height: 16px; margin-right: 4px; color: var(--c-text-secondary); }
input { flex: 1; min-width: 0; min-height: 32px; padding: 5px 8px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; }
input::placeholder { color: var(--c-text-muted); }
.search-count { flex: 0 0 auto; padding: 0 6px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--c-text-secondary); }
button { display: inline-grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
button span { width: 16px; height: 16px; }
button:hover:not(:disabled) { color: var(--c-text); background: var(--c-bg-muted); }
button:disabled { opacity: .4; cursor: not-allowed; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.search-scope, .search-error { margin: 6px 0 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.search-scope { color: var(--c-text-secondary); }
.search-error { color: var(--c-error); }
.search-error button { width: auto; height: auto; padding: 0 4px; color: inherit; text-decoration: underline; font: inherit; }
@container (max-width: 340px) {
  .search-controls { flex-wrap: wrap; }
  .search-icon { display: none; }
  input { flex: 1 0 100%; box-sizing: border-box; }
  .search-count { flex: 1; padding-left: 0; }
}
@media (max-width: 700px), (pointer: coarse) {
  input { min-height: 44px; font-size: 16px; }
  button { flex-basis: 44px; width: 44px; height: 44px; }
  .search-count { padding: 0 2px; }
  .search-icon { display: none; }
}
</style>

<style>
::highlight(shadow-conversation-matches) { background-color: var(--c-warn-bg); color: var(--c-warn); text-decoration: underline; }
::highlight(shadow-conversation-active) { background-color: var(--c-primary-bg); color: var(--c-text-on-primary); text-decoration: underline; }
</style>
