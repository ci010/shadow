import type { AgentTypesManager } from '../agent/types/manager.ts'
import { isSelectableAgentType } from '../agent/types/types.ts'
import type { A2aSessions } from '../a2a/sessions.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

interface WebPreview {
  types: Pick<AgentTypesManager, 'knowledgeDefinitions'>
  sessions: Pick<SessionManager, 'getContext'>
  canRead: (context: ExecutionContext) => boolean
}

const previewPath = 'context/web'

export function createAgentsHandler(
  types: Pick<AgentTypesManager, 'all'>,
  remote?: Pick<A2aSessions, 'agents' | 'canDiscover'>,
  preview?: WebPreview,
): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const entries = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    const local = types.all().filter(isSelectableAgentType).map(type => ({
      name: type.name, content: JSON.stringify({
        name: type.name, kind: 'local', description: type.description, defaultMode: type.defaultMode,
      }, null, 2),
    }))
    const external = remote?.canDiscover(context, 'a2a_agents')
      ? remote.agents(context).map(agent => ({ name: agent.name, content: JSON.stringify(agent, null, 2) })) : []
    return [...local, ...external]
  }
  const previewRoles = () => preview?.types.knowledgeDefinitions().filter(isSelectableAgentType) ?? []
  return {
    read(path, context) {
      const [name, ...segments] = path.split('/')
      const view = segments.join('/')
      const raw = view === `${previewPath}/system-prompt`
      if (view === previewPath || raw) {
        context.signal.throwIfAborted()
        if (!preview?.canRead(context)) throw new Error('Role preview requires a direct turn in the Project owner’s private Web conversation.')
        const role = previewRoles().find(type => type.name === name)
        if (!role) throw new Error('Unknown or unavailable agent reference.')
        return preview.sessions.getContext({ agentType: role.name, channel: 'web', rolePreview: 'owner-web' }).then(result => {
          context.signal.throwIfAborted()
          if (raw) return result.systemPrompt
          return JSON.stringify({ agentType: role.name, channel: 'web', source: result.source,
            rolePreview: result.rolePreview, promptIdentity: result.promptIdentity, systemPrompt: result.systemPrompt, sections: result.sections }, null, 2)
        })
      }
      const all = entries(context)
      if (!path) return all.map(entry => entry.content).join('\n')
      const entry = all.find(entry => entry.name === path)
      if (!entry) throw new Error('Unknown or unavailable agent reference.')
      return entry.content
    },
    list(context, options) {
      const all = entries(context)
      if (preview?.canRead(context)) {
        for (const role of previewRoles()) {
          const name = `${role.name}/${previewPath}`
          all.push({ name, content: 'Knowledge-page Web role preview (JSON with prompt and source sections); use explicit read.' },
            { name: `${name}/system-prompt`, content: 'Knowledge-page Web role preview (raw, line-pageable prompt); use explicit read.' })
        }
      }
      const scope = options?.subpath
      return all.filter(entry => !scope || entry.name === scope || entry.name.startsWith(`${scope}/`))
        .map(entry => ({ ...entry, content: options?.content === false ? '' : entry.content }))
    },
  }
}
