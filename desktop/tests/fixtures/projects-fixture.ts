import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { CloneOperation, ProjectRecord } from '../../../src/projects/contracts.js'

export interface FixtureSession {
  sessionId: string
  title: string
  description: string
  current: string
  projectId?: string
}

export class ProjectsFixture {
  readonly root: string
  readonly initialEmptyId = 'fixture-empty-project'
  readonly treeId = 'fixture-tree-project'
  readonly projects: ProjectRecord[] = []
  readonly operations = new Map<string, CloneOperation>()
  readonly cancelled = new Set<string>()
  readonly registrations: string[] = []
  readonly createdSessions: Array<{ projectId: string; sessionId: string }> = []
  readonly cloneInputs: Array<{ operationId: string; url: string; parentPath: string; directoryName: string }> = []
  readonly acknowledgements = new Map<string, () => void>()
  nextClone: 'succeeded' | 'failed' | 'running' = 'succeeded'
  nextCancellation: 'cancelled' | 'failed' = 'cancelled'
  failedCancellations = 0
  holdNextAcknowledgement = false
  private readonly outcomes = new Map<string, 'succeeded' | 'failed' | 'running'>()
  private readonly originalSessions: FixtureSession[]
  private serial = 0

  constructor(directory: string, readonly sessions: FixtureSession[]) {
    this.root = join(directory, 'synthetic-projects')
    this.originalSessions = sessions.map((session) => ({ ...session }))
    this.reset()
  }

  reset(): void {
    this.sessions.splice(0, this.sessions.length, ...this.originalSessions.map((session) => ({ ...session })))
    this.projects.splice(0)
    this.add(join(this.root, 'Empty registered folder'), this.initialEmptyId)
    this.add(join(this.root, 'A long synthetic project folder '.repeat(5).trim()), this.treeId)
    this.sessions[88]!.projectId = this.treeId
    this.sessions[89]!.projectId = this.treeId
    this.nextClone = 'succeeded'
    this.nextCancellation = 'cancelled'
    this.holdNextAcknowledgement = false
  }

  graph() {
    return {
      sessions: this.sessions,
      nodes: this.sessions.map((session) => ({
        physicalId: session.current,
        logicalId: session.sessionId,
        parentPhysicalId: session.sessionId === this.originalSessions[89]!.sessionId
          ? this.originalSessions[88]!.current : null,
        isCurrent: true,
      })),
    }
  }

  private add(path: string, id = `fixture-project-${++this.serial}`): ProjectRecord {
    const absolute = resolve(path)
    const within = relative(this.root, absolute)
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Only disposable fixture paths may be registered')
    const existing = this.projects.find((project) => project.path.toLowerCase() === absolute.toLowerCase())
    if (existing) return existing
    mkdirSync(absolute, { recursive: true })
    const project = { id, name: basename(absolute), path: absolute, createdAt: '2026-01-01T00:00:00.000Z' }
    this.projects.push(project)
    return project
  }

  async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith('/api/projects')) return false
    const json = (data: unknown, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    const body = async (): Promise<Record<string, string>> => {
      let content = ''
      for await (const chunk of request) content += chunk
      return JSON.parse(content || '{}') as Record<string, string>
    }
    if (path === '/api/projects' && request.method === 'GET') json({ projects: this.projects })
    else if (path === '/api/projects/register' && request.method === 'POST') {
      const input = await body()
      this.registrations.push(input.path!)
      json({ project: this.add(input.path!) })
    } else if (/^\/api\/projects\/[^/]+\/sessions$/.test(path) && request.method === 'POST') {
      const projectId = decodeURIComponent(path.split('/')[3]!)
      assert.ok(this.projects.some((project) => project.id === projectId), 'Conversation requires a registered fixture project')
      const chatId = `chat-project-fixture-${++this.serial}`
      const sessionId = `web:${chatId}`
      this.sessions.push({
        sessionId, projectId, title: `Synthetic conversation ${this.serial}`,
        description: 'Server-bound project conversation', current: `physical-project-${this.serial}`,
      })
      this.createdSessions.push({ projectId, sessionId })
      json({ sessionId, chatId })
    } else if (path === '/api/projects/clone' && request.method === 'POST') {
      const input = await body() as { operationId: string; url: string; parentPath: string; directoryName: string }
      assert.match(input.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      assert.ok(input.url.startsWith('https://example.invalid/'), 'Clone input must be synthetic')
      this.cloneInputs.push(input)
      this.operations.set(input.operationId, {
        id: input.operationId, state: 'running', destination: join(input.parentPath, input.directoryName),
      })
      this.outcomes.set(input.operationId, this.nextClone)
      if (this.holdNextAcknowledgement) {
        this.holdNextAcknowledgement = false
        await new Promise<void>((done) => this.acknowledgements.set(input.operationId, done))
        this.acknowledgements.delete(input.operationId)
      }
      json({ operation: this.operations.get(input.operationId) }, 202)
    } else if (path.startsWith('/api/projects/clone/')) {
      const id = decodeURIComponent(path.slice('/api/projects/clone/'.length))
      let operation = this.operations.get(id) ?? { id, state: 'cancelled' as const, destination: this.root }
      if (request.method === 'DELETE') {
        this.cancelled.add(id)
        if (this.nextCancellation === 'failed') {
          operation = { id, state: 'failed', destination: operation.destination, error: 'Synthetic cancellation failed; partial checkout was retained.' }
          this.failedCancellations += 1
        } else operation = { id, state: 'cancelled', destination: operation.destination }
        this.nextCancellation = 'cancelled'
      } else if (operation.state === 'running') {
        const state = this.outcomes.get(id)!
        if (state === 'succeeded') operation = { ...operation, state, project: this.add(operation.destination) }
        else if (state === 'failed') operation = { ...operation, state, error: 'Synthetic fixture clone failure' }
      }
      this.operations.set(id, operation)
      json({ operation })
    } else json({ error: 'not_found', message: 'No synthetic project endpoint matches this request' }, 404)
    return true
  }
}
