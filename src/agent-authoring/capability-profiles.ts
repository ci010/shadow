import { AgentCapabilityProfilesSchema, type AgentCapabilityProfile, type ResourceSnapshot } from './contracts.ts'
import { PURE_NODE_MODULES } from '../script-runtime/module-policy.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'

/** Absence is deliberately distinct from an explicitly empty, reviewed capability profile. */
export function agentCapabilityProfiles(snapshot: ResourceSnapshot, agent: string): AgentCapabilityProfile[] {
  const file = snapshot.bundle.files[`agents/${agent}/AGENT.md`]
  if (!file) return []
  const value = parseFrontmatter(file).frontmatter.capabilityProfiles
  return value === undefined ? [] : AgentCapabilityProfilesSchema.parse(value)
}

export function profileBindings(snapshot: ResourceSnapshot) {
  return Object.keys(snapshot.bundle.files).flatMap(path => {
    const agent = /^agents\/([^/]+)\/AGENT.md$/.exec(path)?.[1]
    return agent ? agentCapabilityProfiles(snapshot, agent).map(profile => ({ ...profile, agent, enabled: true, conversationId: `profile:${agent}` })) : []
  })
}

/** Display derives only from enforced declarations, never the Agent prompt or credential identifiers. */
export function capabilitySummary(snapshot: ResourceSnapshot, agent: string, profile: AgentCapabilityProfile) {
  const fm = parseFrontmatter(snapshot.bundle.files[`agents/${agent}/AGENT.md`]).frontmatter
  const allowed = new Set(Array.isArray(fm.allowedTools) ? fm.allowedTools : [])
  const blocked = new Set(Array.isArray(fm.blockedTools) ? fm.blockedTools : [])
  return {
    tools: profile.skills.flatMap(skill => {
      const content = snapshot.bundle.files[`skills/${skill}/SKILL.md`]
      const tools = content ? parseFrontmatter(content).frontmatter.tools : {}
      return Object.entries((tools ?? {}) as Record<string, { description?: string }>).filter(([name]) => allowed.has(name) && !blocked.has(name)).map(([name, tool]) => ({ name, description: tool.description ?? name }))
    }),
    hostModules: [...new Set(profile.skills.flatMap(skill => {
      const content = snapshot.bundle.files[`skills/${skill}/SKILL.md`]
      const tools = content ? parseFrontmatter(content).frontmatter.tools : {}
      return Object.entries((tools ?? {}) as Record<string, { imports?: string[] }>).filter(([name]) => allowed.has(name) && !blocked.has(name)).flatMap(([, tool]) => (tool.imports ?? []).filter(name => name.startsWith('node:') && !(PURE_NODE_MODULES as readonly string[]).includes(name)))
    }))],
    reads: ['read', 'search'].filter(name => allowed.has(name) && !blocked.has(name)),
    readFolders: profile.readFolders,
    targets: profile.grants.map(grant => grant.kind === 'http'
      ? { kind: 'http' as const, target: grant.origin, operations: grant.routes.map(route => `${route.method} ${route.path}`), authenticated: !!grant.credential }
      : { kind: 'inbox' as const, target: grant.kind === 'inbox' ? grant.sessionId : grant.inbox, operations: grant.kind === 'proposal-inbox' ? [`propose public issue ${grant.disclosurePolicy.repository}`] : ['send'], authenticated: false }),
    restrictedSenders: profile.allowFrom?.length ?? 0,
  }
}
