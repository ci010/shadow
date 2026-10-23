import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ResourceBundleSchema, ResourceName, conversationBindingKey,
  type ConversationBinding, type ResourceSnapshot,
} from './contracts.ts'
import { PrivateDocument } from './private-document.ts'
import type { AgentResourceStore } from './store.ts'

const MAX_CHANGES = 256
const MAX_REVISIONS = 4096
const MAX_RUNS = 4096
const MAX_RESULT_BYTES = 256 * 1024
const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const snapshotSchema = z.object({ revision, bundle: ResourceBundleSchema }).strict()
const editorSchema = z.object({
  sessionId: identifier, paths: z.array(z.string().min(1).max(256)).max(512),
}).strict()
const changeSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(256), ownerSessionId: identifier,
  editors: z.array(editorSchema).max(128),
  accessRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  base: snapshotSchema, snapshot: snapshotSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), closed: z.boolean(),
  revisions: z.array(revision).min(1).max(MAX_REVISIONS),
}).strict()
const runInputSchema = z.object({
  revision,
  kind: z.enum(['validate', 'preview', 'test', 'probe', 'scenario']),
  status: z.enum(['passed', 'failed', 'completed']),
  result: z.unknown(),
}).strict()
const runSchema = runInputSchema.extend({
  id: z.string().uuid(), changeId: z.string().uuid(), createdAt: z.string().datetime(),
}).strict()
const documentSchema = z.object({
  changes: z.array(changeSchema).max(MAX_CHANGES),
  runs: z.array(runSchema).max(MAX_RUNS),
}).strict()
type Document = { changes: AuthoringChange[]; runs: AuthoringRun[] }

export type AuthoringChange = z.infer<typeof changeSchema>
export type AuthoringRun = Omit<z.infer<typeof runSchema>, 'result'> & { result: unknown }

export class AuthoringConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super(`Authoring rebase conflicts: ${conflicts.join(', ')}`)
    this.name = 'AuthoringConflictError'
  }
}

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function unique(values: string[], label: string): void {
  insist(new Set(values).size === values.length, `Duplicate ${label}`)
}

function safePath(path: string, directory = false): void {
  insist(typeof path === 'string' && path.length <= 256 &&
    !path.split('/').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)),
  'Unsafe resource path')
  const parts = path.split('/')
  const [kind, name, file] = parts
  if (directory && path.endsWith('/')) {
    insist((parts.length === 2 || parts.length === 3) && (kind === 'agents' || kind === 'skills') &&
      (parts.length === 2 || ResourceName.safeParse(name).success), `Unsafe resource scope: ${path}`)
    return
  }
  insist(parts.length === 3 && ResourceName.safeParse(name).success &&
    ((kind === 'agents' && file === 'AGENT.md') ||
      (kind === 'skills' && (file === 'SKILL.md' ||
        (/\.(?:js|ts)$/.test(file) && ResourceName.safeParse(file.slice(0, -3)).success)))),
  `Unsafe or unsupported resource path: ${path}`)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

/** Independent published-base changes; neither edits nor evidence activate resources. */
export class AuthoringChanges {
  private readonly document: PrivateDocument<Document>
  private readonly resources: AgentResourceStore

  constructor(options: {
    projectId: string
    directory: string
    resources: AgentResourceStore
  }) {
    this.resources = options.resources
    this.document = new PrivateDocument({
      projectId: options.projectId, directory: options.directory, filename: 'changes.json',
      initial: { changes: [], runs: [] },
      parse: value => this.parseDocument(value),
    })
  }

  list(): AuthoringChange[] { return this.document.read().changes }

  get(id: string): AuthoringChange { return this.find(this.document.read(), id) }

  create(input: {
    title: string
    ownerSessionId: string
    editors?: Array<{ sessionId: string; paths: string[] }>
  }): AuthoringChange {
    const parsed = z.object({
      title: changeSchema.shape.title, ownerSessionId: identifier,
      editors: z.array(editorSchema).max(128).default([]),
    }).strict().parse(input)
    const document = this.document.read()
    insist(document.changes.length < MAX_CHANGES, 'Authoring change limit reached')
    const snapshot = this.resources.snapshot()
    const now = new Date().toISOString()
    const change: AuthoringChange = {
      ...parsed, id: randomUUID(), base: snapshot, snapshot,
      createdAt: now, updatedAt: now, closed: false, revisions: [snapshot.revision], accessRevision: 0,
    }
    document.changes.push(change)
    this.document.write(document)
    return this.get(change.id)
  }

  edit(id: string, input: {
    expectedRevision: string
    files?: Record<string, string | null>
    bindings?: ConversationBinding[]
  }): AuthoringChange {
    const parsed = z.object({
      expectedRevision: revision,
      files: z.record(z.union([z.string().max(512_000), z.null()])).optional(),
      bindings: ResourceBundleSchema.shape.bindings.optional(),
    }).strict().parse(input)
    // Validate original keys as well: schema parsers may omit special object keys.
    if (input.files) for (const path of Object.keys(input.files)) safePath(path)
    return this.update(id, change => {
      this.expected(change, parsed.expectedRevision)
      const bundle = structuredClone(change.snapshot.bundle)
      for (const [path, content] of Object.entries(parsed.files ?? {})) {
        safePath(path)
        if (content === null) delete bundle.files[path]
        else bundle.files[path] = content
      }
      if (parsed.bindings !== undefined) bundle.bindings = parsed.bindings
      this.advance(change, this.resources.candidate(bundle))
    })
  }

  delegate(id: string, input: { sessionId: string; paths: string[] }): AuthoringChange {
    const editor = editorSchema.parse(input)
    return this.update(id, change => {
      insist(editor.sessionId !== change.ownerSessionId, 'Owner does not need delegation')
      const previous = change.editors.findIndex(item => item.sessionId === editor.sessionId)
      if (previous < 0) change.editors.push(editor)
      else change.editors[previous] = editor
      this.advanceAccess(change)
    })
  }

  revoke(id: string, sessionId: string): AuthoringChange {
    identifier.parse(sessionId)
    return this.update(id, change => {
      insist(sessionId !== change.ownerSessionId, 'Cannot revoke change owner')
      change.editors = change.editors.filter(editor => editor.sessionId !== sessionId)
      this.advanceAccess(change)
    })
  }

  authorize(id: string, sessionId: string, path?: string): void {
    const change = this.get(id)
    identifier.parse(sessionId)
    if (path !== undefined) {
      this.open(change)
      safePath(path)
    }
    if (sessionId === change.ownerSessionId) return
    const editor = change.editors.find(item => item.sessionId === sessionId)
    insist(editor, 'Session is not a registered change editor')
    if (path !== undefined) insist(editor.paths.some(scope =>
      scope.endsWith('/') ? path.startsWith(scope) : path === scope), 'Resource path is outside delegated editor scope')
  }

  rebase(id: string, expectedRevision: string): AuthoringChange {
    return this.update(id, change => {
      this.expected(change, expectedRevision)
      const published = this.resources.snapshot()
      const conflicts: string[] = []
      const merge = <T>(base: Map<string, T>, ours: Map<string, T>, theirs: Map<string, T>, prefix: string) => {
        const result = new Map<string, T>()
        for (const key of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
          const before = base.get(key), local = ours.get(key), remote = theirs.get(key)
          if (!same(local, before) && !same(remote, before) && !same(local, remote)) {
            conflicts.push(`${prefix}${key}`)
          } else {
            const value = same(local, before) ? remote : local
            if (value !== undefined) result.set(key, value)
          }
        }
        return result
      }
      const files = merge(
        new Map(Object.entries(change.base.bundle.files)),
        new Map(Object.entries(change.snapshot.bundle.files)),
        new Map(Object.entries(published.bundle.files)), '',
      )
      const bindings = (snapshot: ResourceSnapshot) =>
        new Map(snapshot.bundle.bindings.map(binding => [conversationBindingKey(binding), binding]))
      const mergedBindings = merge(bindings(change.base), bindings(change.snapshot), bindings(published), 'bindings:')
      if (conflicts.length) throw new AuthoringConflictError(conflicts.sort())
      change.base = published
      this.advance(change, this.resources.candidate({
        version: 1, files: Object.fromEntries(files), bindings: [...mergedBindings.values()],
      }))
    })
  }

  recordRun(id: string, input: {
    revision: string
    kind: AuthoringRun['kind']
    status: AuthoringRun['status']
    result: unknown
  }): AuthoringRun {
    const parsed = runInputSchema.parse(input)
    const document = this.document.read()
    const change = this.find(document, id)
    // Admission is checked by the caller before execution; already-running
    // checks must retain evidence even after closure or editor revocation.
    insist(change.revisions.includes(parsed.revision), 'Unknown change revision for evidence')
    insist(document.runs.length < MAX_RUNS, 'Authoring evidence limit reached')
    const run: AuthoringRun = {
      ...parsed, result: parsed.result, id: randomUUID(), changeId: id, createdAt: new Date().toISOString(),
    }
    document.runs.push(run)
    this.document.write(document)
    return this.run(id, run.id)
  }

  run(id: string, runId: string): AuthoringRun {
    const run = this.runs(id).find(item => item.id === runId)
    insist(run, 'Authoring run not found')
    return run
  }

  runs(id: string): AuthoringRun[] {
    const document = this.document.read()
    this.find(document, id)
    return document.runs.filter(run => run.changeId === id)
  }

  close(id: string, expectedRevision: string): AuthoringChange {
    return this.update(id, change => {
      this.expected(change, expectedRevision)
      change.closed = true
    })
  }

  private find(document: Document, id: string): AuthoringChange {
    const change = document.changes.find(item => item.id === id)
    insist(change, 'Authoring change not found')
    return change
  }

  private open(change: AuthoringChange): void {
    insist(!change.closed, 'Authoring change is closed')
  }

  private expected(change: AuthoringChange, expected: string): void {
    insist(change.snapshot.revision === expected, 'Stale change revision')
  }

  private advance(change: AuthoringChange, snapshot: ResourceSnapshot): void {
    if (!change.revisions.includes(snapshot.revision)) {
      insist(change.revisions.length < MAX_REVISIONS, 'Authoring revision history limit reached')
      change.revisions.push(snapshot.revision)
    }
    change.snapshot = snapshot
  }

  private advanceAccess(change: AuthoringChange): void {
    insist(change.accessRevision < Number.MAX_SAFE_INTEGER, 'Authoring access revision limit reached')
    change.accessRevision += 1
  }

  private update(id: string, mutate: (change: AuthoringChange) => void): AuthoringChange {
    const document = this.document.read()
    const change = this.find(document, id)
    this.open(change)
    mutate(change)
    change.updatedAt = new Date().toISOString()
    this.document.write(document)
    return this.get(id)
  }

  private parseDocument(value: unknown): Document {
    const document = documentSchema.parse(value)
    unique(document.changes.map(change => change.id), 'change IDs')
    unique(document.runs.map(run => run.id), 'run IDs')
    for (const change of document.changes) {
      unique(change.revisions, 'change revisions')
      insist(change.revisions.includes(change.snapshot.revision), 'Current change revision missing from history')
      unique(change.editors.map(editor => editor.sessionId), 'editor sessions')
      for (const editor of change.editors) {
        insist(editor.sessionId !== change.ownerSessionId, 'Owner does not need delegation')
        unique(editor.paths, 'editor scopes')
        for (const path of editor.paths) safePath(path, true)
      }
      for (const snapshot of [change.base, change.snapshot]) {
        for (const path of Object.keys(snapshot.bundle.files)) safePath(path)
        insist(this.resources.candidate(snapshot.bundle).revision === snapshot.revision,
          'Change revision does not match bundle')
        unique(snapshot.bundle.bindings.map(conversationBindingKey), 'conversation bindings')
      }
    }
    for (const run of document.runs) {
      const change = document.changes.find(change => change.id === run.changeId)
      insist(change, 'Authoring change not found')
      insist(change.revisions.includes(run.revision), 'Unknown change revision for evidence')
      insist(Object.hasOwn(run, 'result') && run.result !== undefined, 'Run result must be JSON data')
      insist(Buffer.byteLength(JSON.stringify(run.result)) <= MAX_RESULT_BYTES, 'Authoring run result exceeds size limit')
    }
    return document as Document
  }
}
