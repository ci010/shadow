import type { AgentTypeDefinition } from '../types/types.ts'
import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const limit = 16 * 1024
const validRevision = /^[a-f0-9]{64}$/
const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** Host-owned project data, never a caller-selected path or execution workspace. */
export class SubOverrideStore {
  constructor(private projectHome: string, private directoryName = 'sub-prompt-drafts') {}

  forAgent(agent: AgentTypeDefinition): SubOverrideStore {
    if (agent.source === 'builtin' && agent.name === 'sub' && !agent.runtimeOrigin) return this
    return new SubOverrideStore(this.projectHome, `agent-prompt-drafts-${revisionOf(JSON.stringify(agentDraftScope(agent)))}`)
  }

  private async directory(create: boolean): Promise<string> {
    const root = realpathSync(this.projectHome)
    const directory = resolve(root, this.directoryName)
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
      throw new Error('Unsafe sub draft directory')
    }
    return directory
  }

  async read(revision: unknown): Promise<string> {
    if (typeof revision !== 'string' || !validRevision.test(revision)) throw new Error('Invalid sub draft revision')
    try {
      const directory = await this.directory(false)
      const path = join(directory, `${revision}.md`)
      const entry = lstatSync(path)
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > limit) throw new Error('Unsafe sub draft file')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.dev !== entry.dev || stat.ino !== entry.ino) {
          throw new Error('Unsafe sub draft file')
        }
        const bytes = Buffer.alloc(limit + 1)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        const text = bytes.subarray(0, bytesRead).toString('utf8')
        if (bytesRead !== stat.size || Buffer.byteLength(text) !== bytesRead || revisionOf(text) !== revision) {
          throw new Error('Sub draft integrity check failed')
        }
        return text
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Explicit sub draft revision was not found')
      throw error
    }
  }

  async save(markdown: string): Promise<string> {
    if (!markdown.trim() || Buffer.byteLength(markdown) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(markdown) || Buffer.from(markdown).toString('utf8') !== markdown) {
      throw new Error('Sub draft must be nonempty Markdown (at most 16 KiB) without control characters')
    }
    const revision = revisionOf(markdown)
    const directory = await this.directory(true)
    const temporary = join(directory, `.draft-${randomUUID()}`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(markdown); await file.sync() } finally { await file.close() }
      await link(temporary, join(directory, `${revision}.md`)).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
    } finally { await unlink(temporary) }
    await this.read(revision)
    return revision
  }
}

/** The registry, not a path or a caller-provided identity, selects the namespace. */
export function agentDraftScope(agent: AgentTypeDefinition) {
  return [agent.source, agent.name, agent.runtimeOrigin?.kind, agent.runtimeOrigin?.id, agent.runtimeOrigin?.revision]
}

export type AgentPromptDraft = { scope: string; revision: string; markdown: string }

export function parseAgentPromptDraft(value: unknown): AgentPromptDraft {
  if (!value || typeof value !== 'object' || !('scope' in value) || typeof value.scope !== 'string' ||
    !('revision' in value) || typeof value.revision !== 'string' || !validRevision.test(value.revision) ||
    !('markdown' in value) || typeof value.markdown !== 'string' || Buffer.byteLength(value.markdown) > limit ||
    revisionOf(value.markdown) !== value.revision) {
    throw new Error('Invalid pinned agent prompt draft')
  }
  return { scope: value.scope, revision: value.revision, markdown: value.markdown }
}

export async function readAgentPromptDraft(store: SubOverrideStore, agent: AgentTypeDefinition, revision: string): Promise<AgentPromptDraft> {
  return { scope: JSON.stringify(agentDraftScope(agent)), revision, markdown: await store.forAgent(agent).read(revision) }
}
