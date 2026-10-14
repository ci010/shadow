import type { AutomationRunHistory } from '../automation-run-history.ts'
import { computed, inject, type ComputedRef, type InjectionKey } from 'vue'
import type { AutomationSummary, AutomationRunSummary } from '../automations.ts'

export interface AutomationConversation {
  sessionId: ComputedRef<string | undefined>
  automation: ComputedRef<AutomationSummary | null>
  run: ComputedRef<AutomationRunSummary | undefined>
  loading: ComputedRef<boolean>
  error: ComputedRef<string>
  historyError: ComputedRef<string>
  hasPrevious: ComputedRef<boolean>
  historical: ComputedRef<boolean>
  history?: AutomationRunHistory
  loadMore?(): void
  select?(sessionId: string): void
  previous(): void
  next(): void
  current(): void
  refresh(): void
  updating?: ComputedRef<boolean>
  updateError?: ComputedRef<string>
  toggle?(): void
  retry(): void
}

export const automationConversationKey: InjectionKey<AutomationConversation> = Symbol('automation-conversation')

export function useAutomationConversation(sessionId: () => string, enabled: () => boolean) {
  const conversation = inject(automationConversationKey, undefined)
  return computed(() => enabled() && sessionId() && conversation?.sessionId.value === sessionId() ? conversation : undefined)
}
