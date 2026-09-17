import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { CloneOperation, FolderRecord } from '../../../src/folders/contracts.js'

export interface FixtureSession {
  sessionId: string
  title: string
  description: string
  current: string
  folderId?: string
}

export class FoldersFixture {
  readonly root: string
  readonly initialEmptyId = 'fixture-empty-folder'
  readonly treeId = 'fixture-tree-folder'
  readonly folders: FolderRecord[] = []
  readonly operations = new Map<string, CloneOperation>()
  readonly cancelled = new Set<string>()
  readonly registrations: string[] = []
  readonly createdSessions: Array<{ folderId: string; sessionId: string }> = []
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
    this.root = join(directory, 'synthetic-folders')
    this.originalSessions = sessions.map((session) => ({ ...session }))
    this.reset()
  }

  reset(): void {
    this.sessions.splice(0, this.sessions.length, ...this.originalSessions.map((session) => ({ ...session })))
    this.folders.splice(0)
    this.add(join(this.root, 'Empty registered folder'), this.initialEmptyId)
    this.add(join(this.root, 'A long synthetic folder '.repeat(5).trim()), this.treeId)
    this.sessions[88]!.folderId = this.treeId
    this.sessions[89]!.folderId = this.treeId
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

  private add(path: string, id = `fixture-folder-${++this.serial}`): FolderRecord {
    const absolute = resolve(path)
    const within = relative(this.root, absolute)
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Only disposable fixture paths may be registered')
    const existing = this.folders.find((folder) => folder.path.toLowerCase() === absolute.toLowerCase())
    if (existing) return existing
    mkdirSync(absolute, { recursive: true })
    const folder = { id, name: basename(absolute), path: absolute, createdAt: '2026-01-01T00:00:00.000Z' }
    this.folders.push(folder)
    return folder
  }

  async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith('/api/folders')) return false
    const json = (data: unknown, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    const body = async (): Promise<Record<string, string>> => {
      let content = ''
      for await (const chunk of request) content += chunk
      return JSON.parse(content || '{}') as Record<string, string>
    }
    if (path === '/api/folders' && request.method === 'GET') json({ folders: this.folders })
    else if (path === '/api/folders/register' && request.method === 'POST') {
      const input = await body()
      this.registrations.push(input.path!)
      json({ folder: this.add(input.path!) })
    } else if (/^\/api\/folders\/[^/]+\/sessions$/.test(path) && request.method === 'POST') {
      const folderId = decodeURIComponent(path.split('/')[3]!)
      assert.ok(this.folders.some((folder) => folder.id === folderId), 'Conversation requires a registered fixture folder')
      const chatId = `chat-folder-fixture-${++this.serial}`
      const sessionId = `web:${chatId}`
      this.sessions.push({
        sessionId, folderId, title: `Synthetic conversation ${this.serial}`,
        description: 'Server-bound folder conversation', current: `physical-folder-${this.serial}`,
      })
      this.createdSessions.push({ folderId, sessionId })
      json({ sessionId, chatId })
    } else if (path === '/api/folders/clone' && request.method === 'POST') {
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
    } else if (path.startsWith('/api/folders/clone/')) {
      const id = decodeURIComponent(path.slice('/api/folders/clone/'.length))
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
        if (state === 'succeeded') operation = { ...operation, state, folder: this.add(operation.destination) }
        else if (state === 'failed') operation = { ...operation, state, error: 'Synthetic fixture clone failure' }
      }
      this.operations.set(id, operation)
      json({ operation })
    } else json({ error: 'not_found', message: 'No synthetic folder endpoint matches this request' }, 404)
    return true
  }
}
