import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { A2aSessions } from '../a2a/sessions.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

export function createAgentsHandler(
  types: Pick<AgentTypesManager, 'all'>,
  remote?: Pick<A2aSessions, 'agents' | 'canDiscover'>,
): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const entries = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    const local = types.all().filter(type => type.name !== 'orchestrator').map(type => ({
      name: type.name, content: JSON.stringify({
        name: type.name, kind: 'local', description: type.description, defaultMode: type.defaultMode,
      }, null, 2),
    }))
    const external = remote?.canDiscover(context, 'a2a_agents')
      ? remote.agents(context).map(agent => ({ name: agent.name, content: JSON.stringify(agent, null, 2) })) : []
    return [...local, ...external]
  }
  return {
    read(path, context) {
      const all = entries(context)
      if (!path) return all.map(entry => entry.content).join('\n')
      const entry = all.find(entry => entry.name === path)
      if (!entry) throw new Error('Unknown or unavailable agent reference.')
      return entry.content
    },
    list(context, options) {
      return entries(context).filter(entry => !options?.subpath || entry.name === options.subpath)
        .map(entry => ({ ...entry, content: options?.content === false ? '' : entry.content }))
    },
  }
}
