import { z } from 'zod'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { MicroApps } from '../microapps/service.ts'
import { appId, revisionId, microAppCapabilities, MicroAppError } from '../microapps/contracts.ts'
import { localAppDirectory } from '../microapps/store.ts'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capabilities') }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('get'), id: appId }).strict(),
  z.object({ action: z.literal('publish'), directory: z.string().min(1), id: appId.optional(), revision: revisionId.optional() }).strict(),
  z.object({ action: z.literal('start'), id: appId }).strict(),
  z.object({ action: z.literal('stop'), id: appId }).strict(),
])
export class MicroAppTool implements Tool {
  readonly name = 'micro_app'
  readonly readonly = (args: Record<string, unknown>) => ['capabilities', 'list', 'get'].includes(String(args.action))
  readonly description = 'Publish and manage reusable Project Web apps, with optional local Node/Python backend and owner-approved LLM calls. Read v:skills/micro-app and action:capabilities for SDK persistence, temporary storage and runtime limits. Immutable versions require human review in Apps; this tool cannot approve or issue model credentials. No automatic install.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['capabilities', 'list', 'get', 'publish', 'start', 'stop'] },
      directory: { type: 'string', description: 'publish: local workdir-relative directory containing shadow-app.json and its explicitly listed files.' },
      id: { type: 'string', description: 'App UUID. Omit on first publish.' },
      revision: { type: 'string', description: 'publish updates: current revision from get; stop the app first. Updates invalidate approval.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private service: MicroApps, private assertSession: (id: string) => void) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext) {
    if (context.projectId !== this.service.projectId || context.remoteWorkdir) throw new MicroAppError('local_project_required', 'Micro Apps require their owning local Project', 403)
    this.assertSession(context.sessionId)
    context.signal.throwIfAborted()
    const input = inputSchema.parse(args)
    if (input.action === 'capabilities') return JSON.stringify(microAppCapabilities)
    if (input.action === 'list') return JSON.stringify({ apps: this.service.list() })
    if (input.action === 'get') return JSON.stringify(this.service.get(input.id))
    if (input.action === 'publish') {
      if (!context.cwd) throw new MicroAppError('workdir_required', 'A local workdir is required')
      const directory = await localAppDirectory(context.cwd, input.directory)
      const stat = await lstat(join(directory, 'shadow-app.json'))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new MicroAppError('invalid_manifest', 'Manifest must be a regular file of at most 64 KiB')
      const bytes = await readFile(join(directory, 'shadow-app.json'), { signal: context.signal })
      if (bytes.length > 64 * 1024) throw new MicroAppError('manifest_too_large', 'App manifest exceeds 64 KiB', 413)
      return JSON.stringify(await this.service.publish(directory, JSON.parse(bytes.toString('utf8')), context.sessionId, context.signal, input.id, input.revision))
    }
    if (this.service.get(input.id).createdBy !== context.sessionId) throw new MicroAppError('not_app_author', 'Only the author session or the Project owner can control this app', 403)
    return JSON.stringify(await this.service[input.action](input.id))
  }
}
