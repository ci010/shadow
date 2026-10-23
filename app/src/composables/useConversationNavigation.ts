import { ref } from 'vue'
import type { Router } from 'vue-router'
import { childConversationTarget } from '../conversation-split.ts'
import type { SidebarSession } from '../folders-sidebar.ts'

export function useConversationNavigation(options: {
  props: {
    embedded?: boolean; managed?: boolean; sessionId?: string; childSessionId?: string
    enableChildPane?: boolean; projectId?: string
  }
  router: Pick<Router, 'replace'>
  emit: {
    (event: 'open-child', target: { primaryId: string; childId: string }): void
    (event: 'close-child'): void
    (event: 'primary-change', id: string): void
    (event: 'navigate', id: string): void
    (event: 'child-navigation', id: string): void
  }
  sessions: () => SidebarSession[]
  reset: () => void
  refresh: () => void
  mounted: () => boolean
  newDraft: () => void
}) {
  const { props, router, emit } = options
  const activeSessionId = ref(props.embedded || props.managed ? props.sessionId ?? '' : '')
  const selectedMode = ref<SidebarSession['mode']>()

  function selectSession(sessionId: string, syncRoute = true): void {
    options.reset()
    activeSessionId.value = sessionId
    selectedMode.value = options.sessions().find(session => session.sessionId === sessionId)?.mode
    if (!props.embedded && syncRoute) {
      emit('primary-change', sessionId)
      if (props.managed) emit('navigate', sessionId)
      else void router.replace({ name: 'chat', params: { projectId: props.projectId, sessionId } })
    }
    options.refresh()
  }
  function requestSession(sessionId: string): void {
    if (sessionId === activeSessionId.value && !props.childSessionId) return
    if (props.enableChildPane) {
      const target = childConversationTarget(options.sessions(), sessionId, activeSessionId.value)
      if (target) {
        if (!props.managed && target.primaryId !== activeSessionId.value) selectSession(target.primaryId, false)
        emit('open-child', target)
        return
      }
      if (props.childSessionId && sessionId === activeSessionId.value) {
        emit('primary-change', sessionId)
        if (props.managed) emit('navigate', sessionId)
        else void router.replace({ name: 'chat', params: { projectId: props.projectId, sessionId } })
        return
      }
    }
    if (props.managed) emit('navigate', sessionId)
    else selectSession(sessionId)
  }
  function inspectExecution(sessionId: string): void {
    if (props.embedded && !props.enableChildPane) emit('child-navigation', sessionId)
    else if (props.enableChildPane && props.childSessionId === sessionId) emit('close-child')
    else requestSession(sessionId)
  }
  function restoreSession(sessionId: string): void {
    if (!options.mounted() || props.embedded || activeSessionId.value === sessionId) return
    if (!sessionId) options.newDraft()
    else if (options.sessions().some(session => session.sessionId === sessionId)) selectSession(sessionId, false)
  }
  return { activeSessionId, selectedMode, requestSession, selectSession, inspectExecution, restoreSession }
}
