import { watch } from 'vue'
import { projectBase } from './api-url.ts'
import { isOneShot } from './subagent-executions.ts'
import { isWorkingStage } from './session-activity.ts'
import { projectJson, type ProjectConversationState } from './projects.ts'
import { parseYieldResponse } from './yield-requests.ts'
import type { LiveClient } from './live-client.ts'
import type { ProjectLiveState } from './project-live-state.ts'
import type { NotificationSound } from './notification-sounds.ts'
import { isRecord } from './folders-sidebar.ts'

export function createSessionSoundTracker() {
  let previous: Map<string, string> | undefined
  const questions = new Map<string, string>()
  const completed = new Map<string, string>()
  return {
    reset() { previous = undefined; questions.clear(); completed.clear() },
    observe(snapshot: ProjectConversationState) {
      const current = new Map(snapshot.sessions.filter(session => !isOneShot(session)).map(session =>
        [session.sessionId, snapshot.stages[session.sessionId] ?? 'inactive']))
      const idle: string[] = []
      const waiting = [...current].filter(([, stage]) => stage === 'waiting').map(([id]) => id)
      const baseline = previous === undefined
      if (previous) {
        for (const [id, stage] of current) {
          const before = previous.get(id)
          if (stage === 'idle' && before && before !== 'waiting' && isWorkingStage(before)) idle.push(id)
        }
      }
      for (const id of questions.keys()) if (!current.has(id)) questions.delete(id)
      for (const id of completed.keys()) if (!current.has(id)) completed.delete(id)
      previous = current
      return { idle, waiting, baseline }
    },
    question(sessionId: string, requestId: string, silent = false) {
      if (questions.get(sessionId) === requestId) return false
      questions.set(sessionId, requestId)
      return !silent
    },
    completion(sessionId: string, turnId: string) {
      if (completed.get(sessionId) === turnId) return false
      completed.set(sessionId, turnId)
      return true
    },
  }
}

/** App-owned observation keeps notifications independent of mounted chat panes. */
export function startSessionSoundMonitor(options: {
  base: string
  live: Partial<Pick<LiveClient, 'isLive'>>
  state: ProjectLiveState
  notify: (kind: NotificationSound) => void
  error: (message: string) => void
  request?: typeof fetch
}) {
  const lifetime = new AbortController()
  const projects = new Map<string, { close: () => void }>()
  const errors = new Map<string, string>()
  const request = options.request ?? fetch
  function report(id: string, message: string) {
    if (message) errors.set(id, message)
    else errors.delete(id)
    options.error([...new Set(errors.values())].join(' '))
  }
  function monitor(projectId: string) {
    const tracker = createSessionSoundTracker()
    const finished = new Map<string, string>()
    let controller: AbortController | undefined
    let dirty = false
    let closed = false
    let generation = 0
    async function refresh() {
      if (closed || lifetime.signal.aborted) return
      const { graph, activity } = lease
      if (graph.state.loading || activity.state.loading) return
      if (controller) { dirty = true; return }
      if ((!graph.state.value || !activity.state.value) && !graph.state.error && !activity.state.error) return
      dirty = false
      const ownGeneration = generation
      const current = controller = new AbortController()
      const signal = AbortSignal.any([current.signal, lifetime.signal])
      try {
        if (graph.state.error || activity.state.error) throw new Error(graph.state.error || activity.state.error)
        if (!graph.state.value || !activity.state.value) return
        const snapshot: ProjectConversationState = {
          sessions: graph.state.value, stages: activity.state.value.stages, sessionsError: '', stagesError: '',
        }
        if (options.live.isLive && !options.live.isLive()) { tracker.reset(); finished.clear() }
        const changes = tracker.observe(snapshot)
        let idle = changes.idle.length > 0
        for (const [sessionId, turnId] of finished) {
          const session = snapshot.sessions.find(session => session.sessionId === sessionId)
          if (session && !isOneShot(session) && snapshot.stages[sessionId] === 'idle') {
            if (tracker.completion(sessionId, turnId) && !changes.baseline) idle = true
            finished.delete(sessionId)
          } else if ((session && isOneShot(session)) || (!session && !dirty)) finished.delete(sessionId)
        }
        let needsAnswer = false
        for (const sessionId of changes.waiting) {
          const value = await projectJson(projectBase(options.base, projectId),
            `/api/sessions/${encodeURIComponent(sessionId)}/ask`, { signal }, request)
          if (signal.aborted || ownGeneration !== generation) return
          const question = parseYieldResponse(value, sessionId)
          if (question?.recipient.kind === 'user' && tracker.question(sessionId, question.id, changes.baseline)) needsAnswer = true
        }
        if (needsAnswer) options.notify('yield')
        else if (idle) options.notify('idle')
        report(`project:${projectId}`, '')
      } catch (cause) {
        if (!signal.aborted && ownGeneration === generation) {
          tracker.reset()
          finished.clear()
          report(`project:${projectId}`, `Some session sounds are unavailable. ${cause instanceof Error ? cause.message : 'Could not read session activity.'}`)
        }
      } finally {
        if (controller === current) {
          controller = undefined
          if (dirty && !closed && !lifetime.signal.aborted) void refresh()
        }
      }
    }
    const lease = options.state.acquireProject(options.base, projectId, {
      event: event => {
        const payload = event.payload
        if (options.live.isLive && !options.live.isLive()) {
          tracker.reset()
          finished.clear()
        } else if (isRecord(payload) && payload.event === 'invalidate'
          && typeof payload.sessionId === 'string' && payload.sessionId.length > 0 && payload.sessionId.length <= 512
          && typeof payload.completedTurnId === 'string' && payload.completedTurnId.length > 0 && payload.completedTurnId.length <= 512) {
          finished.set(payload.sessionId, payload.completedTurnId)
        }
      },
      reset: () => {
        generation++
        tracker.reset()
        finished.clear()
        controller?.abort()
        controller = undefined
      },
    })
    const stopWatching = watch(() => [
      lease.graph.state.revision, lease.graph.state.loading, lease.graph.state.error,
      lease.activity.state.revision, lease.activity.state.loading, lease.activity.state.error,
    ], () => { void refresh() }, { immediate: true })
    return { close() { closed = true; controller?.abort(); stopWatching(); lease.release(); errors.delete(`project:${projectId}`) } }
  }
  const catalog = options.state.acquireCatalog(options.base)
  const stopCatalog = watch(() => [catalog.state.revision, catalog.state.error], () => {
    if (catalog.state.error) { report('catalog', `Session sounds are unavailable. ${catalog.state.error}`); return }
    if (!catalog.state.value) return
    const ids = new Set(catalog.state.value.map(project => project.id))
    for (const [id, project] of projects) if (!ids.has(id)) { project.close(); projects.delete(id) }
    for (const id of ids) if (!projects.has(id)) projects.set(id, monitor(id))
    report('catalog', '')
  }, { immediate: true })
  return () => {
    lifetime.abort()
    stopCatalog()
    catalog.release()
    for (const project of projects.values()) project.close()
    projects.clear()
    options.error('')
  }
}
