import { shallowRef, type ShallowRef } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import type { SessionRef } from '../api-url.ts'
import { automationChatLocation } from '../automations.ts'

/** Run identity comes from the route or a known graph row, never the current run page. */
export function useAutomationNavigation(options: {
  route: RouteLocationNormalizedLoaded
  router: Pick<Router, 'push' | 'replace'>
  selected: ShallowRef<SessionRef | undefined>
  openSession: (session: SessionRef) => void
  closeSidebar: () => void
}) {
  const { route, router, selected } = options
  const automation = shallowRef<{ projectId: string; id: string }>()

  function syncAutomationRoute(projectId: string) {
    const id = typeof route.query.automation === 'string' && route.query.automation.trim() ? route.query.automation : undefined
    automation.value = id ? { projectId, id } : undefined
    return id
  }
  function showAutomation(projectId: string, id: string) {
    automation.value = { projectId, id }
    selected.value = undefined
    options.closeSidebar()
    void router.push(automationChatLocation(projectId, id))
  }
  function openAutomationRun(sessionId: string, replace = false) {
    const owner = automation.value
    if (!owner) return
    options.openSession({ projectId: owner.projectId, sessionId })
    const location = automationChatLocation(owner.projectId, owner.id, sessionId)
    void (replace ? router.replace(location) : router.push(location))
  }
  function identifyAutomation(projectId: string, sessionId: string, jobId?: string) {
    if (selected.value?.projectId !== projectId || selected.value.sessionId !== sessionId) return
    automation.value = jobId ? { projectId, id: jobId } : undefined
    if (route.name === 'chat' && route.params.projectId === projectId
      && route.params.sessionId === sessionId && route.query.automation !== jobId) {
      const query = { ...route.query }
      if (jobId) query.automation = jobId
      else delete query.automation
      void router.replace({ query })
    }
  }
  return { automation, syncAutomationRoute, showAutomation, openAutomationRun, identifyAutomation }
}
