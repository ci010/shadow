import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import { assertSupportedJsonSchema } from './capabilities.ts'
import {
  AgentCapabilityProfilesSchema, AuthoredToolSchema, ResourceBundleSchema, ResourceName, conversationBindingKey,
  type PublishedAgent, type PublishedTool, type ResourceBundle, type ResourceSnapshot, type ResolvedConversationPolicy,
} from './contracts.ts'
import { ScriptImportsSchema, assertImportPolicy, importedModules } from '../script-runtime/module-policy.ts'
import { LegacyAuthoredToolSchema, legacyToolCode } from './legacy-tools.ts'

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_TOOL_SOURCE_BYTES = 256 * 1024
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
const MAX_HISTORY = 20
const MAX_MANAGED = 10_000
const reservedAgents = new Set([
  'general', 'general-legacy', 'sub', 'explore', 'eval', 'plan', 'verify',
  'reflector', 'soul-reflector', 'encapsulator',
])
const reservedTools = new Set([
  'read', 'search', 'glob', 'grep', 'exec', 'write', 'invoke_tool', 'import_tool',
  'install_tool', 'message', 'session', 'subagent', 'project', 'project_config', 'authoring_change', 'skill_read', 'skill_save',
  'initiative', 'ask', 'reply', 'cron', 'cron_add', 'cron_list', 'cron_remove', 'cancel', 'continuation', 'event_subscribe',
  'sql', 'update_convention', 'io_surface', 'io_capabilities', 'io_run', 'log',
  'plan_write', 'web_search', 'search_tools',
])
export const agentInferenceSchema = z.object({
  model: z.string().min(1).optional(), temperature: z.number().finite().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).strict()
const agentFrontmatter = z.object({
  name: ResourceName.optional(), description: z.string().optional(),
  capabilityProfiles: AgentCapabilityProfilesSchema.optional(),
  allowedTools: z.array(ResourceName), blockedTools: z.array(ResourceName).optional(),
  allowedModules: ScriptImportsSchema.optional(),
  defaultMode: z.enum(['session', 'task', 'call']).optional(),
  ephemeral: z.boolean().optional(), skills: z.boolean().optional(),
  soul: z.boolean().optional(), root: z.literal(false).optional(),
  ...agentInferenceSchema.shape,
}).strict()
const skillFrontmatter = z.object({
  name: ResourceName.optional(), description: z.string().optional(),
  tools: z.record(AuthoredToolSchema).default({}),
}).strict()
const legacySkillFrontmatter = skillFrontmatter.extend({
  tools: z.record(z.union([AuthoredToolSchema, LegacyAuthoredToolSchema])).default({}),
})
const snapshotSchema = z.object({
  revision: z.string().regex(/^sha256:[a-f0-9]{64}$/), bundle: ResourceBundleSchema,
}).strict()
const documentFields = {
  projectId: z.string().min(1),
  draft: snapshotSchema, published: snapshotSchema,
  history: z.array(snapshotSchema).max(MAX_HISTORY),
  managed: z.array(z.string().max(4096)).max(MAX_MANAGED),
}
const currentDocumentSchema = z.object({
  ...documentFields, version: z.literal(2),
  legacyRevisions: z.array(snapshotSchema.shape.revision).max(MAX_HISTORY + 2),
}).strict()
const documentSchema = z.union([
  currentDocumentSchema,
  z.object({ ...documentFields, version: z.literal(1) }).strict(),
])
type StoreDocument = z.infer<typeof currentDocumentSchema>
type ParsedResources = {
  agents: Map<string, PublishedAgent>
  skills: Map<string, { content: string; tools: PublishedTool[] }>
  legacyTools: Set<string>
}

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function plainJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  insist(depth <= 64, 'JSON nesting exceeds limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    insist(Number.isFinite(value), 'JSON numbers must be finite')
    return
  }
  insist(typeof value === 'object' && value !== null, 'Expected plain JSON data')
  insist(!seen.has(value), 'Circular JSON data')
  insist(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null, 'Expected plain JSON objects')
  seen.add(value)
  insist(Reflect.ownKeys(value).every(key => typeof key === 'string'), 'JSON symbol keys are unsupported')
  if (Array.isArray(value)) {
    insist(Object.keys(value).length === value.length &&
      Object.keys(value).every((key, index) => key === String(index)), 'Expected a dense JSON array')
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue
    insist(key !== '__proto__', 'Unsafe JSON property: __proto__')
    insist('value' in descriptor && descriptor.enumerable, 'JSON accessors are unsupported')
    plainJson(descriptor.value, depth + 1, seen)
  }
  seen.delete(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function copy<T>(value: T): T {
  return freeze(structuredClone(value))
}

function unique(values: string[], label: string): void {
  insist(new Set(values).size === values.length, `Duplicate ${label}`)
}

function bundleSnapshot(input: unknown): ResourceSnapshot {
  plainJson(input)
  insist(Buffer.byteLength(canonical(input)) <= MAX_BUNDLE_BYTES, 'Bundle exceeds size limit')
  const bundle = ResourceBundleSchema.parse(input)
  insist(Object.keys(bundle.files).length <= 512, 'Too many resource files')
  for (const [path, content] of Object.entries(bundle.files)) {
    const parts = path.split('/')
    const [kind, name, file] = parts
    insist((parts.length === 3 && ResourceName.safeParse(name).success &&
      ((kind === 'agents' && file === 'AGENT.md') ||
        (kind === 'skills' && (file === 'SKILL.md' ||
          (/\.(?:js|ts)$/.test(file) && ResourceName.safeParse(file.slice(0, -3)).success))))),
    `Unsafe or unsupported resource path: ${path}`)
    insist(Buffer.byteLength(content) <= 512_000, `Resource file exceeds size limit: ${path}`)
  }
  const text = canonical(bundle)
  insist(Buffer.byteLength(text) <= MAX_BUNDLE_BYTES, 'Bundle exceeds size limit')
  return { revision: hash(text), bundle: structuredClone(bundle) }
}

function checkedSnapshot(input: ResourceSnapshot): ResourceSnapshot {
  snapshotSchema.parse(input)
  const checked = bundleSnapshot(input.bundle)
  insist(checked.revision === input.revision, 'Resource revision does not match bundle')
  return checked
}

function markdown(content: string): ReturnType<typeof parseFrontmatter> {
  const normalized = content.replace(/\r\n/g, '\n')
  insist(/^---\n[\s\S]*?\n---\n/.test(normalized), 'Resource requires valid YAML frontmatter')
  const parsed = parseFrontmatter(content)
  plainJson(parsed.frontmatter)
  return parsed
}

function safeRoute(path: string): void {
  insist(!/[%\\?#\x00-\x20\x7f]/.test(path) && !path.startsWith('//') &&
    !path.split('/').some(part => part === '.' || part === '..'),
  `Unsafe HTTP route path: ${path}`)
}

function parseResources(bundle: ResourceBundle, projectId: string, allowLegacy = false): ParsedResources {
  const agents: ParsedResources['agents'] = new Map()
  const skills: ParsedResources['skills'] = new Map()
  const aliases = new Set<string>()
  const usedSources = new Set<string>()
  const legacyTools = new Set<string>()
  const profileBindings: ResourceBundle['bindings'] = []
  for (const [path, content] of Object.entries(bundle.files)) {
    const [, name, file] = path.split('/')
    if (file === 'AGENT.md') {
      insist(!reservedAgents.has(name), `Builtin agent name is reserved: ${name}`)
      const fm = agentFrontmatter.parse(markdown(content).frontmatter)
      insist(fm.name === undefined || fm.name === name, `Agent name must match path: ${path}`)
      unique((fm.capabilityProfiles ?? []).map(profile => JSON.stringify([profile.botInstanceId, profile.platform])), 'Agent capability profile scopes')
      for (const profile of fm.capabilityProfiles ?? []) {
        profileBindings.push({ ...profile, agent: name, conversationId: `profile:${name}`, enabled: true })
      }
      unique(fm.allowedTools, 'agent allowed tools')
      unique(fm.blockedTools ?? [], 'agent blocked tools')
      unique(fm.allowedModules ?? [], 'agent allowed modules')
      insist(fm.ephemeral === undefined || fm.defaultMode === undefined, 'Use defaultMode without ephemeral')
      const agent = parseAgentFile(content, name, '')
      delete agent.dirPath
      agents.set(name, { ...agent, source: 'workspace', root: false, skills: false, soul: false,
        ...(fm.allowedModules ? { allowedModules: fm.allowedModules } : {}) })
    } else if (file === 'SKILL.md') {
      const parsed = markdown(content)
      const fm = (allowLegacy ? legacySkillFrontmatter : skillFrontmatter).parse(parsed.frontmatter)
      insist(fm.name === undefined || fm.name === name, `Skill name must match path: ${path}`)
      const tools: PublishedTool[] = []
      for (const [alias, declaration] of Object.entries(fm.tools)) {
        insist(ResourceName.safeParse(alias).success && !reservedTools.has(alias),
          `Unsafe or reserved tool alias: ${alias}`)
        insist(!aliases.has(alias), `Duplicate tool alias: ${alias}`)
        aliases.add(alias)
        const legacy = 'capabilities' in declaration
        const imports = legacy ? declaration.capabilities.map(id => `@shadow/${id}`) : declaration.imports
        assertImportPolicy(imports, imports)
        insist(declaration.parameters.type === 'object', 'Authored tool parameters must have type object')
        assertSupportedJsonSchema(declaration.parameters)
        const source = `skills/${name}/${declaration.source}`
        insist(Object.hasOwn(bundle.files, source), `Missing tool source: ${source}`)
        insist(Buffer.byteLength(bundle.files[source], 'utf8') <= MAX_TOOL_SOURCE_BYTES,
          `Tool source exceeds ${MAX_TOOL_SOURCE_BYTES}-byte restricted runtime limit: ${source}`)
        usedSources.add(source)
        if (legacy) legacyTools.add(alias)
        const code = legacy ? legacyToolCode(bundle.files[source], declaration.capabilities) : bundle.files[source]
        insist(Buffer.byteLength(code, 'utf8') <= MAX_TOOL_SOURCE_BYTES,
          `Legacy tool and compatibility bridge exceed ${MAX_TOOL_SOURCE_BYTES}-byte restricted runtime limit: ${source}`)
        tools.push({
          source: declaration.source, description: declaration.description, parameters: declaration.parameters,
          imports, name: alias, skill: name,
          code,
        })
      }
      skills.set(name, { content: parsed.body, tools })
    }
  }
  for (const path of Object.keys(bundle.files)) {
    insist(!/\.(?:js|ts)$/.test(path) || usedSources.has(path), `Undeclared tool source: ${path}`)
  }
  // Even unbound agents cannot hide a privileged tool request in the draft.
  for (const agent of agents.values()) {
    for (const name of agent.allowedTools!) {
      insist(name === 'read' || name === 'search' || aliases.has(name), `Tool is not permitted: ${name}`)
    }
  }
  unique(bundle.bindings.map(conversationBindingKey), 'conversation bindings')
  for (const binding of [...bundle.bindings, ...profileBindings]) {
    const agent = agents.get(binding.agent)
    insist(agent, `Missing custom agent: ${binding.agent}`)
    unique(binding.skills, 'selected skills')
    unique(binding.readFolders, 'read folders')
    unique(binding.allowFrom ?? [], 'allowed senders')
    unique(binding.grants.map(grant => grant.id), 'capability grants')
    const tools: PublishedTool[] = []
    for (const name of binding.skills) {
      const skill = skills.get(name)
      insist(skill, `Missing custom skill: ${name}`)
      tools.push(...skill.tools)
    }
    const grantIds = new Set(binding.grants.map(grant => grant.id))
    for (const tool of tools) {
      // Old roles had no module ceiling: their authority was exactly the
      // declared capability IDs intersected with each conversation's grants.
      assertImportPolicy(tool.imports,
        agent.allowedModules ?? (legacyTools.has(tool.name) ? tool.imports : []))
      for (const capability of importedModules(tool.imports)) {
        insist(grantIds.has(capability), `Tool ${tool.name} requires missing grant: ${capability}`)
      }
    }
    const permitted = new Set(['read', 'search', ...tools.map(tool => tool.name)])
    for (const name of agent.allowedTools!) {
      insist(permitted.has(name), `Tool is not bound to conversation: ${name}`)
    }
    for (const grant of binding.grants) {
      if (grant.kind === 'http') {
        unique(grant.routes.map(route => `${route.method} ${route.path}`), 'HTTP routes')
        for (const route of grant.routes) {
          safeRoute(route.path)
          if (route.bodySchema) assertSupportedJsonSchema(route.bodySchema)
        }
        if (grant.credential) insist(!/[\r\n\x00]/.test(grant.credential.prefix), 'Unsafe credential prefix')
      } else {
        const address = { ...binding, projectId }
        insist(!['self', 'current', binding.conversationId, `${binding.platform}:${binding.conversationId}`,
          channelSessionId(address)].includes(grant.sessionId), 'Inbox cannot target its own group session')
      }
    }
  }
  return { agents, skills, legacyTools }
}

/** Private versioned documents; authored files are never materialized into live resource directories. */
export class AgentResourceStore {
  private readonly file: string
  private readonly directory: string
  private readonly projectId: string
  private document: StoreDocument
  private diskHash?: string
  private pending: Promise<unknown> = Promise.resolve()
  private readonly changeListeners = new Set<() => void>()

  constructor(options: { projectId: string; directory: string }) {
    insist(typeof options.projectId === 'string' && options.projectId.trim().length > 0, 'Project ID is required')
    this.projectId = options.projectId
    this.directory = resolve(options.directory)
    this.file = join(this.directory, 'resources.json')
    const empty = bundleSnapshot({ version: 1, files: {}, bindings: [] })
    this.document = {
      version: 2, projectId: this.projectId, draft: empty, published: empty, history: [], managed: [],
      legacyRevisions: [],
    }
    const text = this.readDocument()
    if (text !== undefined) {
      const raw: unknown = JSON.parse(text)
      plainJson(raw)
      const loaded = documentSchema.parse(raw)
      const snapshots = [loaded.draft, loaded.published, ...loaded.history]
      const document: StoreDocument = loaded.version === 1
        ? { ...loaded, version: 2, legacyRevisions: [...new Set(snapshots.map(snapshot => snapshot.revision))] }
        : loaded
      insist(document.projectId === this.projectId, 'Resource store belongs to another project')
      unique(document.legacyRevisions, 'legacy resource revisions')
      insist(document.legacyRevisions.every(revision => snapshots.some(snapshot => snapshot.revision === revision)),
        'Unknown legacy resource revision')
      checkedSnapshot(document.draft)
      for (const snapshot of [document.published, ...document.history]) {
        checkedSnapshot(snapshot)
        parseResources(snapshot.bundle, this.projectId, document.legacyRevisions.includes(snapshot.revision))
      }
      unique(document.history.map(snapshot => snapshot.revision), 'history revisions')
      unique(document.managed, 'managed conversations')
      for (const key of document.managed) {
        const parts: unknown = JSON.parse(key)
        insist(Array.isArray(parts) && parts.length === 3 &&
          parts.every(part => typeof part === 'string' && part.length > 0) &&
          ['qq', 'discord', 'feishu'].includes(parts[1]) && JSON.stringify(parts) === key,
        'Invalid managed conversation key')
      }
      insist(document.history.length > 0
        ? document.history.at(-1)!.revision === document.published.revision
        : document.published.revision === empty.revision, 'Published snapshot is missing from history')
      for (const snapshot of [document.published, ...document.history]) {
        for (const binding of snapshot.bundle.bindings) {
          insist(document.managed.includes(conversationBindingKey(binding)), 'Missing managed conversation tombstone')
        }
      }
      this.document = document
      this.diskHash = hash(text)
      // Preserve original bundles and content-addressed revisions. Only these
      // already-persisted revisions may use the old declaration/entry contract.
      if (loaded.version === 1) this.persist(document)
    }
  }

  get storageDirectory(): string { return this.directory }
  snapshot(): ResourceSnapshot { return copy(this.document.published) }
  draft(): ResourceSnapshot { return copy(this.document.draft) }
  candidate(bundle: ResourceBundle): ResourceSnapshot { return copy(bundleSnapshot(bundle)) }
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }
  retained(revision: string): ResourceSnapshot {
    const snapshot = this.document.history.find(item => item.revision === revision)
    insist(snapshot, 'Unknown or pruned Release')
    return copy(snapshot)
  }

  history(): Array<{ revision: string }> {
    return copy(this.document.history.map(({ revision }) => ({ revision })))
  }

  validate(snapshot: ResourceSnapshot = this.document.draft): { valid: boolean; errors: string[]; summary: unknown } {
    try {
      const checked = checkedSnapshot(snapshot)
      const parsed = parseResources(checked.bundle, this.projectId, this.document.legacyRevisions.includes(checked.revision))
      return {
        valid: true, errors: [],
        summary: {
          revision: checked.revision, agents: [...parsed.agents.keys()], skills: [...parsed.skills.keys()],
          tools: [...parsed.skills.values()].flatMap(skill => skill.tools.map(tool => tool.name)),
          legacyTools: [...parsed.legacyTools],
          bindings: checked.bundle.bindings.length,
        },
      }
    } catch (error) {
      return { valid: false, errors: [error instanceof Error ? error.message : String(error)], summary: null }
    }
  }

  stage(input: { expectedRevision: string; expectedActiveRelease?: string; bundle: ResourceBundle }): Promise<ResourceSnapshot> {
    // Capture caller-owned input before waiting for earlier mutations.
    let next: ResourceSnapshot
    try { next = bundleSnapshot(input.bundle) } catch (error) { return Promise.reject(error) }
    const expectedActive = input.expectedActiveRelease
    const expected = input.expectedRevision
    return this.serialize(() => {
      insist(expected === this.document.draft.revision, 'Stale draft revision')
      insist(expectedActive === undefined || expectedActive === this.document.published.revision, 'Stale active Release')
      this.persist({ ...this.document, draft: next })
      return this.draft()
    })
  }

  publish(expectedDraftRevision: string, approval?: {
    baseRevision: string
    validateLive: (snapshot: ResourceSnapshot) => Promise<void>
    assertPending?: () => void
  }): Promise<ResourceSnapshot> {
    return this.serialize(async () => {
      approval?.assertPending?.()
      insist(expectedDraftRevision === this.document.draft.revision, 'Stale draft revision')
      if (approval) {
        insist(approval.baseRevision === this.document.published.revision, 'Stale published revision')
        approval.assertPending?.()
        const validation = this.validate()
        insist(validation.valid, `Invalid resource draft: ${validation.errors.join('; ')}`)
        await approval.validateLive(this.draft())
        approval.assertPending?.()
      }
      return this.activate(this.document.draft)
    })
  }

  publishSnapshot(snapshot: ResourceSnapshot, approval: {
    baseRevision: string
    validateLive: (snapshot: ResourceSnapshot) => Promise<void>
    assertPending?: () => void
  }): Promise<ResourceSnapshot> {
    let candidate: ResourceSnapshot
    try { candidate = copy(checkedSnapshot(snapshot)) } catch (error) { return Promise.reject(error) }
    const { baseRevision, validateLive, assertPending } = approval
    return this.serialize(async () => {
      assertPending?.()
      insist(baseRevision === this.document.published.revision, 'Stale published revision')
      const validation = this.validate(candidate)
      insist(validation.valid, `Invalid resource candidate: ${validation.errors.join('; ')}`)
      await validateLive(copy(candidate))
      assertPending?.()
      insist(baseRevision === this.document.published.revision, 'Stale published revision')
      return this.activate(candidate)
    })
  }

  rollback(publishedRevision: string, expectedCurrentRevision: string): Promise<ResourceSnapshot> {
    return this.serialize(() => {
      insist(expectedCurrentRevision === this.document.published.revision, 'Stale published revision')
      const snapshot = this.document.history.find(item => item.revision === publishedRevision)
      insist(snapshot, 'Unknown or pruned published revision')
      return this.activate(snapshot)
    })
  }

  isManaged(address: ChannelAddress): boolean {
    return address.projectId === this.projectId && this.document.managed.includes(conversationBindingKey(address))
  }

  resolve(address: ChannelAddress): ResolvedConversationPolicy | undefined {
    return this.resolveSnapshot(address, this.document.published)
  }

  preview(address: ChannelAddress, snapshot: ResourceSnapshot = this.draft()): ResolvedConversationPolicy | undefined {
    return this.resolveSnapshot(address, snapshot)
  }

  private resolveSnapshot(address: ChannelAddress, input: ResourceSnapshot): ResolvedConversationPolicy | undefined {
    if (address.projectId !== this.projectId) return undefined
    const snapshot = checkedSnapshot(input)
    const parsed = parseResources(snapshot.bundle, this.projectId, this.document.legacyRevisions.includes(snapshot.revision))
    const binding = snapshot.bundle.bindings.find(item =>
      item.enabled && conversationBindingKey(item) === conversationBindingKey(address))
    if (!binding) return undefined
    const agent = parsed.agents.get(binding.agent)!
    const tools = binding.skills.flatMap(name => parsed.skills.get(name)!.tools)
    const legacyImports = [...new Set(tools.filter(tool => parsed.legacyTools.has(tool.name)).flatMap(tool => tool.imports))]
    return copy({
      revision: snapshot.revision, binding,
      agent: agent.allowedModules === undefined && legacyImports.length
        ? { ...agent, allowedModules: legacyImports } : agent,
      skillPrompts: binding.skills.map(name => ({ name, content: parsed.skills.get(name)!.content })),
      tools,
    })
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }

  private activate(snapshot: ResourceSnapshot): ResourceSnapshot {
    const validation = this.validate(snapshot)
    insist(validation.valid, `Invalid resource draft: ${validation.errors.join('; ')}`)
    const managed = [...new Set([...this.document.managed, ...snapshot.bundle.bindings.map(conversationBindingKey)])]
    insist(managed.length <= MAX_MANAGED, 'Managed conversation limit reached; tombstones cannot be discarded')
    const history = [...this.document.history.filter(item => item.revision !== snapshot.revision), snapshot]
      .slice(-MAX_HISTORY)
    const next = { ...this.document, published: snapshot, history, managed }
    this.persist(next, true)
    return this.snapshot()
  }

  private checkBoundary(): void {
    let path = this.file
    while (true) {
      try {
        const info = lstatSync(path)
        insist(!info.isSymbolicLink(), 'Symlink resource storage boundary is forbidden')
        insist(path === this.file ? info.isFile() && info.nlink === 1 : info.isDirectory(),
          'Invalid resource storage boundary')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = dirname(path)
      if (parent === path) break
      path = parent
    }
  }

  private readDocument(): string | undefined {
    this.checkBoundary()
    try {
      insist(lstatSync(this.file).size <= MAX_DOCUMENT_BYTES, 'Resource document exceeds size limit')
      return readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private persist(next: StoreDocument, publication = false): void {
    const current = this.readDocument()
    insist((current === undefined ? undefined : hash(current)) === this.diskHash,
      'Resource document changed externally; reopen the store')
    next = { ...next, history: [...next.history] }
    while (next.history.length > 1 && Buffer.byteLength(canonical(next)) + 1 > MAX_DOCUMENT_BYTES) {
      next.history.shift()
    }
    const revisions = new Set([next.draft, next.published, ...next.history].map(snapshot => snapshot.revision))
    next.legacyRevisions = next.legacyRevisions.filter(revision => revisions.has(revision))
    const text = canonical(next) + '\n'
    insist(Buffer.byteLength(text) <= MAX_DOCUMENT_BYTES, 'Resource document exceeds size limit')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.checkBoundary()
    writePrivateFile(this.file, text)
    this.diskHash = hash(text)
    const changed = next.draft.revision !== this.document.draft.revision ||
      next.published.revision !== this.document.published.revision
    this.document = next
    if (changed || publication) for (const listener of this.changeListeners) listener()
  }
}
