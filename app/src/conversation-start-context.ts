import type { InjectionKey, Ref } from 'vue'
import type { ActiveBackgroundTasks } from './background-tasks.ts'
import type { SessionDetails } from './session-details.ts'
import type { WorkView } from './work-alignment.ts'

export interface ConversationScheduleSummary {
  id: string
  name: string
  task: string
  schedule: string
  enabled: boolean
  nextRun: string | null
}

export interface ConversationStartData {
  details?: SessionDetails
  work?: WorkView
  backgroundTasks?: ActiveBackgroundTasks
  scheduledTasks?: ConversationScheduleSummary[]
  botSetup?: { pending: boolean }
  followUp?: { scheduled: boolean }
}

/** Scoped by pane, API base and logical session. An omitted resource is not an empty result. */
export type ConversationStartState = { apiBase: string; sessionId: string } & (
  | { phase: 'pending' | 'http' }
  | { phase: 'socket'; data: ConversationStartData }
)
export const conversationStartKey: InjectionKey<Readonly<Ref<ConversationStartState | undefined>>> = Symbol('conversation-start')
