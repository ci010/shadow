import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { backgroundExecutionId, type BackgroundTaskManager } from '../agent/background-task.ts'
import { Aria2Downloader, downloadSchema } from '../downloader/aria2.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  downloadSchema.extend({ action: z.literal('download') }),
  downloadSchema.extend({ action: z.literal('start') }),
])

export class DownloadTool implements Tool {
  readonly name = 'download'
  readonly description = 'Download one approved HTTPS file with the pinned bundled aria2c. Use start for background transfers; resume partial data and verify SHA-256 before exposing the result. Read v:skills/download.'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'status'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'download', 'start'] },
      url: { type: 'string', description: 'download: trusted HTTPS file URL; no embedded credentials' },
      directory: { type: 'string', description: 'download: existing, user-approved absolute directory (not an internal HF cache)' },
      filename: { type: 'string', description: 'download: safe output basename; repeated calls resume the same partial file' },
      sha256: { type: 'string', description: 'download: expected 64-character SHA-256 from a trusted model/release manifest' },
      bytes: { type: 'integer', description: 'download: optional expected byte count for size and free-space checks' },
      approved: { type: 'boolean', description: 'download: true only after user approved source, destination, license and disk use' },
    },
    required: ['action'], additionalProperties: false,
  }

  constructor(
    private readonly downloader: Aria2Downloader,
    private readonly projectId: string,
    private readonly tasks?: Pick<BackgroundTaskManager, 'runPromiseTask'>,
  ) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('Download requires the owning Project context')
    if (context.remoteWorkdir) throw new Error('Download requires a local workdir; remote nodes need their own execution capability')
    context.signal.throwIfAborted()
    const input = argsSchema.parse(args)
    if (input.action === 'status') return JSON.stringify(await this.downloader.status())
    const { action: _action, ...request } = input
    if (input.action === 'download') return JSON.stringify(await this.downloader.download(request, context.signal))
    if (!this.tasks) throw new Error('Background downloads are not available in this context')
    const controller = new AbortController()
    const partial = join(request.directory, `${request.filename}.shadow-part`)
    const promise = this.downloader.download(request, controller.signal).then(result => JSON.stringify(result))
    try {
      const id = this.tasks.runPromiseTask({
        kind: 'tool', title: `Download: ${request.filename}`,
        sessionId: context.sessionId, inputId: context.messageId,
        callback: {
          sessionId: context.sessionId,
          replyTo: { channel: context.channel, chatId: context.chatId },
          isGroup: context.isGroup, senderName: 'Background Task',
        },
        observe: async () => {
          try {
            const file = await stat(partial)
            return JSON.stringify({ filename: request.filename, downloadedBytes: file.size })
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
              return JSON.stringify({ filename: request.filename, downloadedBytes: 0 })
            }
            throw error
          }
        },
        onCancel: () => controller.abort(new Error('Download cancelled; partial file kept for resumption')),
      }, promise)
      const executionId = backgroundExecutionId(id)
      return JSON.stringify({ executionId, outputPath: `v:bg/${executionId}`, taskId: id, filename: request.filename })
    } catch (error) {
      controller.abort(error)
      await promise.catch(() => {})
      throw error
    }
  }
}
