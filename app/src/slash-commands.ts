import { t } from './i18n.ts'
import { computed, onUnmounted, ref, watch } from 'vue'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export interface SlashCommand { name: string; description: string }

export function parseSlashCommands(value: unknown): SlashCommand[] {
  if (!isRecord(value) || !Array.isArray(value.commands) || value.commands.length > 128) {
    throw new Error(t('Invalid slash command catalog.'))
  }
  const names = new Set<string>()
  return value.commands.map((item: unknown) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.name)
      || typeof item.description !== 'string' || item.description.length > 4096 || names.has(item.name)) {
      throw new Error(t('Invalid slash command catalog.'))
    }
    names.add(item.name)
    return { name: item.name, description: item.description }
  })
}

export function slashCommandQuery(text: string, start: number, end = start): string | null {
  if (start !== end || start !== text.length) return null
  return /^[ \t]*\/([a-z0-9_-]*)$/i.exec(text)?.[1].toLowerCase() ?? null
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  return commands.filter(command => command.name.startsWith(query))
}

export function useSlashCommandCatalog(source: () => { apiBase: string; sessionId: string; enabled: boolean }) {
  const commands = ref<SlashCommand[]>([])
  const loading = ref(false)
  const error = ref('')
  let request: AbortController | undefined
  let generation = 0
  const scope = computed(() => [source().apiBase, source().sessionId, source().enabled] as const)

  function clear() {
    generation++
    request?.abort()
    request = undefined
    commands.value = []
    loading.value = false
    error.value = ''
  }
  async function refresh() {
    if (!source().enabled || request) return
    const current = generation
    const controller = new AbortController()
    request = controller
    loading.value = true
    error.value = ''
    try {
      const url = apiUrl(source().apiBase, '/api/chat/commands')
      if (source().sessionId) url.searchParams.set('sessionId', source().sessionId)
      const response = await fetch(url, {
        cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error(t('Command catalog unavailable ({status}).', { status: response.status }))
      const next = parseSlashCommands(await response.json())
      if (current === generation && !controller.signal.aborted) commands.value = next
    } catch {
      if (current === generation && !controller.signal.aborted) {
        error.value = t('Could not load commands. Check your connection and retry.')
      }
    } finally {
      if (current === generation) { loading.value = false; request = undefined }
    }
  }
  watch(scope, () => { clear(); void refresh() }, { immediate: true, flush: 'sync' })
  onUnmounted(clear)
  return { commands, loading, error, refresh }
}
