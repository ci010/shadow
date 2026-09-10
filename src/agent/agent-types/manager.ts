import { workspacePath } from '../../utils/paths.ts'
import { getBuiltinAgentTypes } from './builtins.ts'
import { AgentTypeRegistry } from './registry.ts'
import type { AgentTypeDefinition } from './types.ts'
import { AgentTypesWatcher } from './watcher.ts'

export type { AgentTypeDefinition } from './types.ts'

/**
 * Manages agent type definitions: built-in types (general, sub, explore, eval,
 * plan) plus user-defined types discovered from `workspace/agents/<name>/AGENT.md`.
 *
 * Follows the same pattern as `SkillsManager`.
 */
export class AgentTypesManager {
  private registry: AgentTypeRegistry
  private watcher: AgentTypesWatcher
  private agentsDir: string

  constructor(workspace: string) {
    this.agentsDir = workspacePath(workspace, 'agents')
    this.registry = new AgentTypeRegistry()
    this.watcher = new AgentTypesWatcher(this)
  }

  async load(): Promise<void> {
    for (const type of await getBuiltinAgentTypes()) {
      this.registry.registerBuiltin(type)
    }
    await this.watcher.load()
  }

  startWatching(): void {
    this.watcher.start()
  }

  async stopWatching(): Promise<void> {
    await this.watcher.stop()
  }

  // ── Watcher hooks ──────────────────────────────────────────────────────

  watchPaths(): string[] {
    return [this.agentsDir]
  }

  loadPaths(): { agentsDir: string } {
    return { agentsDir: this.agentsDir }
  }

  setWorkspaceType(name: string, type: AgentTypeDefinition): void {
    this.registry.setWorkspaceType(name, type)
  }

  removeWorkspaceType(name: string): void {
    this.registry.removeWorkspaceType(name)
  }

  replaceWorkspaceTypes(types: Map<string, AgentTypeDefinition>): void {
    this.registry.replaceWorkspaceTypes(types)
  }

  // ── Public API ─────────────────────────────────────────────────────────

  resolve(name: string): AgentTypeDefinition | undefined {
    return this.registry.resolve(name)
  }

  allNames(): string[] {
    return this.registry.allNames()
  }

  all(): AgentTypeDefinition[] {
    return this.registry.all()
  }

  /** Summary for injection into the system prompt (shows non-general types). */
  getAgentTypesSummary(): string {
    const types = this.all().filter((t) => !t.root)
    if (types.length === 0) return ''
    const lines = types.map((t) => {
      const tags: string[] = []
      if (t.ephemeral) tags.push('ephemeral')
      if (t.source === 'workspace') tags.push('custom')
      const suffix = tags.length ? ` (${tags.join(', ')})` : ''
      return `  <agent_type name="${t.name}">${t.description}${suffix}</agent_type>`
    })
    return `<available_agent_types>\n${lines.join('\n')}\n</available_agent_types>`
  }
}
