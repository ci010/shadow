import { z } from 'zod'
import type { IoBroker } from '../io/broker.ts'
import { assertIoContext, createIoRun, IO_GUIDE, ioRunHandle, type IoToolContext } from './io.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish'), definition: z.unknown().refine(value => value !== undefined, 'definition is required') }).strict(),
  z.object({ action: z.literal('get'), id: z.string().uuid(), includeDefinition: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('close'), id: z.string().uuid() }).strict(),
])

export class IoSurfaceTool implements Tool {
  readonly name = 'io_surface'
  readonly supportsRemoteWorkdir = false
  readonly readonly = (args: Record<string, unknown>) => args.action === 'get'
  readonly description = `Publish a frontend I/O panel connected to an already-started arbitrary-language local WebSocket service. The service drives controls/status/previews and owns business logic and output paths; there is no inline script engine or sink graph. Publishing creates a NEW run awaiting human consent. Get inspects it; close cancels the link but does not kill the service process. New endpoint/sources/budgets require a new complete definition and consent. Read ${IO_GUIDE} for the connection protocol.`
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['publish', 'get', 'close'] },
      definition: { type: 'object', description: `publish only: complete {version:1,title,purpose,endpoint:loopback ws/wss URL,sources,limits:{durationMs,maxBytes},ui?}. No program/sinks fields. Read ${IO_GUIDE}.` },
      id: { type: 'string', description: 'get/close only: run UUID from publish.' },
      includeDefinition: { type: 'boolean', description: 'get only: include the full connection definition and initial UI; defaults false.' },
    },
    required: ['action'], additionalProperties: false,
  }

  constructor(private readonly broker: IoBroker, private readonly projectId: string) {}

  async execute(args: Record<string, unknown>, context: IoToolContext): Promise<string> {
    assertIoContext(this.broker, this.projectId, context)
    const input = argumentsSchema.parse(args)
    if (input.action === 'publish') return JSON.stringify(ioRunHandle(await createIoRun(this.broker, input.definition, context)))
    const run = this.broker.get(input.id, context.sessionId)
    if (input.action === 'close') {
      const stopped = await this.broker.stop(run.id, 'cancelled', 'Surface closed by the owning agent session')
      context.signal.throwIfAborted()
      return JSON.stringify(ioRunHandle(stopped))
    }
    return JSON.stringify({ ...ioRunHandle(run), ...(input.includeDefinition ? { definition: run.definition } : {}) })
  }
}
