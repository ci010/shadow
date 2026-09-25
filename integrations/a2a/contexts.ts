import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../../src/config/store.ts'
import { fingerprint } from '../../src/a2a/service.ts'
import type { InboundTask } from '../../src/a2a/store.ts'
import type { CodingBridgeConfig } from './config.ts'

const schema = z.object({
  version: z.literal(1), owner: z.string(), policy: z.string(), sessionId: z.string().min(1).max(512),
}).strict()

export class CodingContexts {
  private readonly directory: string
  private readonly policy: string

  constructor(config: CodingBridgeConfig) {
    this.directory = join(config.stateDirectory, 'contexts')
    this.policy = fingerprint([config.projectId, config.cwd, config.backend, config.model, config.environment])
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  private path(record: InboundTask) {
    return join(this.directory, `${z.string().uuid().parse(record.task.contextId)}.json`)
  }

  get(record: InboundTask): string | undefined {
    let text: string
    try { text = readFileSync(this.path(record), 'utf8') }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const value = schema.parse(JSON.parse(text))
    if (value.owner !== record.owner || value.policy !== this.policy) throw new Error('Coding context owner or policy changed; start a new A2A context.')
    return value.sessionId
  }

  set(record: InboundTask, sessionId: string) {
    const value = schema.parse({ version: 1, owner: record.owner, policy: this.policy, sessionId })
    writePrivateFile(this.path(record), JSON.stringify(value) + '\n')
  }
}
