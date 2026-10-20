import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../../config/store.ts'
import { fingerprint } from '../service.ts'
import type { InboundTask } from '../store.ts'
import type { CodingBridgeConfig } from './config.ts'

const schema = z.object({
  version: z.literal(1), owner: z.string(), policy: z.string(), sessionId: z.string().uuid(),
}).strict()

export class CodingContexts {
  private readonly directory: string
  private readonly policy: string

  constructor(config: CodingBridgeConfig) {
    this.directory = join(config.stateDirectory, 'contexts')
    this.policy = fingerprint([config.projectId, config.cwd, config.backend, config.model, config.environment, config.executable, 'cli-v1'])
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
