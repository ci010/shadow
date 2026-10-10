<template>
  <Teleport to="body">
    <div class="file-menu-backdrop" @pointerdown.self="close" @contextmenu.prevent.self="close">
      <div ref="menu" class="file-menu" role="menu" :aria-label="t('File actions')" :style="position" @keydown="keydown">
        <button role="menuitem" aria-keyshortcuts="Control+C" :disabled="!paths.full || busy" @click="copyPath(paths.full)">
          <span class="i-lucide-copy" aria-hidden="true" /><span>{{ t('Copy full path') }}</span><kbd aria-hidden="true">Ctrl+C</kbd>
        </button>
        <button role="menuitem" aria-keyshortcuts="Control+Shift+C" :disabled="busy" @click="copyPath(paths.relative)">
          <span class="i-lucide-files" aria-hidden="true" /><span>{{ t('Copy relative path') }}</span><kbd aria-hidden="true">Ctrl+Shift+C</kbd>
        </button>
        <button v-if="canReveal" role="menuitem" aria-keyshortcuts="Alt+Shift+R" :disabled="busy" @click="reveal">
          <span class="i-lucide-folder-open" aria-hidden="true" /><span>{{ t('Show in file explorer') }}</span><kbd aria-hidden="true">Alt+Shift+R</kbd>
        </button>
        <p v-if="error" class="file-menu-error" role="alert">{{ error }}</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../../i18n.ts'
import { canShowInExplorer, fileTreePaths, type FileTreeMenuRequest } from '../../file-tree-menu.ts'
import type { DirListing } from '../../composables/useSessionFiles.ts'
import { useTextCopy } from '../../composables/useTextCopy.ts'

const props = defineProps<{ request: FileTreeMenuRequest; workdir: DirListing['workdir'] }>()
const emit = defineEmits<{ close: [] }>()
const menu = ref<HTMLElement>()
const position = ref({ left: '0px', top: '0px' })
const paths = computed(() => fileTreePaths(props.workdir, props.request.path))
const desktop = typeof window === 'undefined' ? undefined : window.shadowDesktop?.fileExplorer
const canReveal = computed(() => canShowInExplorer(props.workdir, !!desktop, !!props.request.entry?.archive))
const text = ref('')
const { copy, error: copyError, busy: copying } = useTextCopy(text)
const revealError = ref('')
const revealing = ref(false)
const error = computed(() => copyError.value || revealError.value)
const busy = computed(() => copying.value || revealing.value)
const target = props.request.event.target
const anchor = target instanceof HTMLElement ? target.closest<HTMLElement>('button, [tabindex]') ?? target : undefined
function close() { emit('close'); anchor?.focus({ preventScroll: true }) }
async function copyPath(path: string) {
  if (!path || busy.value) return
  text.value = path
  revealError.value = ''
  await copy()
  if (!copyError.value) close()
}
async function reveal() {
  if (!desktop || !canReveal.value || busy.value) return
  revealing.value = true
  revealError.value = ''
  try { await desktop.showInFolder(paths.value.full); close() }
  catch { revealError.value = t('Could not show this path in file explorer. It may have moved or been deleted.') }
  finally { revealing.value = false }
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  const key = event.key.toLowerCase()
  const copyShortcut = key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey
  const revealShortcut = key === 'r' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey
  if (copyShortcut || revealShortcut) {
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || busy.value) return
    if (copyShortcut) void copyPath(event.shiftKey ? paths.value.relative : paths.value.full)
    else void reveal()
    return
  }
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
onMounted(async () => {
  await nextTick()
  const rect = menu.value!.getBoundingClientRect()
  const event = props.request.event
  const anchorRect = anchor?.getBoundingClientRect()
  const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0)
  position.value = {
    left: `${Math.max(8, Math.min(pointer ? event.clientX : anchorRect?.left ?? 8, window.innerWidth - rect.width - 8))}px`,
    top: `${Math.max(8, Math.min(pointer ? event.clientY : anchorRect?.bottom ?? 8, window.innerHeight - rect.height - 8))}px`,
  }
  menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  window.addEventListener('resize', close)
})
onUnmounted(() => window.removeEventListener('resize', close))
</script>

<style scoped>
.file-menu-backdrop { position: fixed; inset: 0; z-index: 900; }
.file-menu { position: fixed; display: flex; flex-direction: column; box-sizing: border-box; width: max-content; max-width: calc(100vw - 16px); padding: 5px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.file-menu button { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 10px; border: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: transparent; color: var(--c-text); font-size: 13px; text-align: left; cursor: pointer; }
.file-menu button > span:first-child { display: block; width: 16px; height: 16px; color: var(--c-text-secondary); }
.file-menu button > span:nth-child(2) { overflow-wrap: anywhere; }
.file-menu kbd { margin-left: 14px; color: var(--c-text-secondary); font: inherit; font-size: 12px; white-space: nowrap; }
.file-menu button:hover:not(:disabled), .file-menu button:focus-visible { background: var(--c-bg-muted); }
.file-menu button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.file-menu button:disabled { opacity: 0.5; cursor: default; }
.file-menu-error { margin: 4px 12px; color: var(--c-error); font-size: 12px; overflow-wrap: anywhere; }
</style>
