import { computed, inject, onBeforeUnmount, useId, watch } from 'vue'
import { IO_TERMINAL, type IoRun } from '../../../src/io/contracts.ts'
import { ioBridgeKey, type IoContext } from './bridge.ts'

export interface IoMessageAnchor { role: string; timestamp?: string; event?: string }

export function placeIoRequests(runs: readonly IoRun[], messages: readonly IoMessageAnchor[]) {
  const after = new Map<number, IoRun[]>()
  const earlier: IoRun[] = []
  const firstTime = messages.map(message => Date.parse(message.timestamp ?? '')).find(Number.isFinite)
  for (const run of [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const time = Date.parse(run.createdAt)
    if (firstTime !== undefined && time < firstTime && IO_TERMINAL.has(run.status)) {
      earlier.push(run)
      continue
    }
    const reply = messages.findIndex(message =>
      message.role === 'assistant' && message.event !== 'tool_call' && message.event !== 'tool_result' && Date.parse(message.timestamp ?? '') >= time)
    const index = reply >= 0 ? reply : messages.length - 1
    after.set(index, [...after.get(index) ?? [], run])
  }
  return { after, earlier }
}

export function useIoConversation(context: () => IoContext | undefined, messages: () => readonly IoMessageAnchor[]) {
  const bridge = inject(ioBridgeKey)
  const id = useId()
  watch(context, value => {
    if (!bridge) return
    const views = new Map(bridge.views.value)
    if (value) { views.set(id, value); bridge.context.value = value }
    else views.delete(id)
    bridge.views.value = views
  }, { immediate: true })
  onBeforeUnmount(() => {
    if (!bridge) return
    const views = new Map(bridge.views.value)
    views.delete(id)
    bridge.views.value = views
  })
  const placement = computed(() => {
    const current = context()
    const runs = current ? (bridge?.runs.value.get(current.apiBase) ?? []).filter(run => run.sessionId === current.sessionId) : []
    return placeIoRequests(runs, messages())
  })
  const error = computed(() => {
    const current = context()
    return current ? bridge?.errors.value.get(current.apiBase) : undefined
  })
  return { after: computed(() => placement.value.after), earlier: computed(() => placement.value.earlier), error }
}
