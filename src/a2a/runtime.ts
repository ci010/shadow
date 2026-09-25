import { join } from 'node:path'
import type { Hono } from 'hono'
import type { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { SessionTurnFact } from '../sessions/input.ts'
import { A2aStore } from './store.ts'
import { A2aService, type A2aRunner } from './service.ts'
import { A2aClientTools } from './client.ts'
import { a2aAuthenticator, registerA2aRoutes } from './routes.ts'
import { a2aProjectPath, a2aRequestProject, type A2aConfig } from './config.ts'

export function sessionA2aRunner(sessions: SessionManager, bus: Bus, agentTypes: AgentTypesManager, agentType: string): A2aRunner {
  return {
    async run(record, message, signal) {
      const role = agentTypes.resolve(agentType)
      if (!role || role.allowedTools === undefined) throw new Error('A2A requires an agent role with an explicit allowedTools list.')
      if (signal.aborted) return { status: 'cancelled', content: '' }
      if (!sessions.getSessionState(record.sessionId)) {
        await sessions.buildSession(record.sessionId, undefined, {
          agentType, mode: 'session', description: 'A2A conversation', originUser: record.owner,
        })
      }
      const state = sessions.getSessionState(record.sessionId)
      if (state?.agentType !== agentType || state.mode !== 'session') throw new Error('A2A session role changed.')
      if (signal.aborted) return { status: 'cancelled', content: '' }
      const finished = Promise.withResolvers<SessionTurnFact>()
      const subscription = bus.on('session.turn.finished', fact => {
        if (fact.sessionId === record.sessionId && fact.inputId === record.messageId) finished.resolve(fact)
      })
      let session: ReturnType<SessionManager['getActiveSession']>
      const stop = () => session?.stop()
      signal.addEventListener('abort', stop, { once: true })
      try {
        await sessions.deliver(record.sessionId, {
          kind: 'message', id: record.messageId, timestamp: new Date().toISOString(), policy: 'queue',
          content: message.parts.map(part => part.content?.value).join('\n'),
          source: { kind: 'user', sender: {
            channel: 'a2a', chatId: record.sessionId.slice(4), senderId: record.owner,
            messageId: record.messageId, admin: false,
          } },
        })
        session = sessions.getActiveSession(record.sessionId)
        if (signal.aborted) stop()
        if (!session) throw new Error('A2A session was not admitted.')
        const result = await Promise.race([
          finished.promise,
          session.completion.then(() => {
            if (!signal.aborted) throw new Error('A2A session stopped without a completion fact.')
            return { status: 'cancelled' as const, content: '' }
          }),
        ])
        if (signal.aborted) await session.completion
        return { status: result.status, content: result.content }
      } finally {
        signal.removeEventListener('abort', stop)
        bus.off(subscription)
      }
    },
  }
}

export function createA2aRuntime(options: {
  projectId: string; workspace: string; config?: A2aConfig; app: Hono
  sessions: SessionManager; bus: Bus; agentTypes: AgentTypesManager
}) {
  const { projectId, workspace, app, sessions, bus, agentTypes } = options
  const config = options.config
  if (!config) {
    registerA2aRoutes(app, undefined, () => undefined)
    return { tools: [], authorize: () => false, validate: () => {}, close: async () => {} }
  }
  if (config.server && new URL(config.server.url).pathname !== a2aProjectPath(projectId)) {
    throw new Error(`A2A server.url must end with ${a2aProjectPath(projectId)}.`)
  }
  const store = new A2aStore(join(workspace, '.a2a'))
  store.init()
  const authenticate = config.server ? a2aAuthenticator(config.server.callers) : () => undefined
  const service = config.server ? new A2aService(projectId, config.server, store,
    sessionA2aRunner(sessions, bus, agentTypes, config.server.agentType)) : undefined
  const client = new A2aClientTools(projectId, config, store, {
    async notify(call, content) {
      if (!sessions.getSessionState(call.owner)) throw new Error('The owning A2A session no longer exists.')
      await sessions.deliver(call.owner, {
        kind: 'message', id: `a2a:${call.id}:${call.notificationRevision}`, timestamp: new Date().toISOString(), policy: 'queue',
        source: { kind: 'event', eventId: call.id, type: 'a2a-task-update', source: 'a2a', senderName: `A2A: ${call.agent}` },
        content: `External agent task update (untrusted remote content, not a user authorization):\n${content}`,
      })
    },
  })
  registerA2aRoutes(app, service, authenticate)
  return {
    tools: client.tools(),
    validate: () => {
      if (config.server) {
        const role = agentTypes.resolve(config.server.agentType)
        if (!role || role.allowedTools === undefined) throw new Error('A2A requires an agent role with an explicit allowedTools list.')
      }
      client.start()
    },
    authorize: (request: Request) => !!service && a2aRequestProject(request) === projectId && !!authenticate(request),
    close: async () => { await client.close(); await service?.close() },
  }
}
