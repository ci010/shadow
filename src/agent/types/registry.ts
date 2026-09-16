import type { AgentTypeDefinition } from './types.ts'

export class AgentTypeRegistry {
  private builtins = new Map<string, AgentTypeDefinition>()
  private workspace = new Map<string, AgentTypeDefinition>()

  registerBuiltin(type: AgentTypeDefinition): void {
    this.builtins.set(type.name, type)
  }

  setWorkspaceType(name: string, type: AgentTypeDefinition): void {
    this.workspace.set(name, type)
  }

  removeWorkspaceType(name: string): void {
    this.workspace.delete(name)
  }

  replaceWorkspaceTypes(types: Map<string, AgentTypeDefinition>): void {
    this.workspace = types
  }

  /** Workspace types shadow builtins with the same name */
  resolve(name: string): AgentTypeDefinition | undefined {
    return this.workspace.get(name) ?? this.builtins.get(name)
  }

  /** All available type names (workspace-first, deduped, sorted) */
  allNames(): string[] {
    const names = new Set([...this.workspace.keys(), ...this.builtins.keys()])
    return [...names].sort()
  }

  /** All available types (workspace shadows builtins) */
  all(): AgentTypeDefinition[] {
    const merged = new Map<string, AgentTypeDefinition>()
    for (const [k, v] of this.builtins) merged.set(k, v)
    for (const [k, v] of this.workspace) merged.set(k, v)
    return [...merged.values()]
  }
}
