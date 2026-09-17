import { z } from 'zod'
import type { IoBroker } from '../io/broker.ts'
import type { IoRun } from '../io/contracts.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export type IoToolContext = Pick<ExecutionContext, 'projectId' | 'sessionId' | 'remoteWorkdir' | 'signal'>
export const IO_GUIDE = 'v:skills/io'

export function assertIoContext(broker: IoBroker, projectId: string, context: IoToolContext): void {
  context.signal.throwIfAborted()
  if (!projectId || context.projectId !== projectId || broker.options.projectId !== projectId) {
    throw new Error('I/O requires the owning Project context.')
  }
  if (!context.sessionId?.trim()) throw new TypeError('A logical session ID is required for I/O.')
  if (context.remoteWorkdir) throw new Error('I/O does not support remote workdirs or remote capture.')
  broker.options.assertSession(context.sessionId)
}

export function ioRunHandle(run: IoRun) {
  return {
    id: run.id, revision: run.revision, status: run.status,
    title: run.definition.title, purpose: run.definition.purpose,
    endpoint: run.definition.endpoint, sources: run.definition.sources, limits: run.definition.limits,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    bytes: run.bytes, artifactCount: run.artifacts.length, error: run.error,
    backendStatus: run.backendStatus, message: run.message,
    ...(run.status === 'awaiting_consent' ? { next: 'The user must review and start the capture card in this conversation. No capture has started.' } : {}),
  }
}

export async function createIoRun(broker: IoBroker, definition: unknown, context: IoToolContext): Promise<IoRun> {
  const run = await broker.create(context.sessionId, definition)
  // A cancelled tool admission must not leave a newly-created consent request behind.
  if (context.signal.aborted) {
    await broker.stop(run.id, 'cancelled', 'The creating agent invocation was aborted')
    context.signal.throwIfAborted()
  }
  return run
}

const runId = z.string().uuid()
const runArguments = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), definition: z.unknown().refine(value => value !== undefined, 'definition is required') }).strict(),
  z.object({ action: z.enum(['get', 'status']), id: runId, includeDefinition: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('stop'), id: runId }).strict(),
  z.object({ action: z.literal('outputs'), id: runId, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
])

export class IoCapabilitiesTool implements Tool {
  readonly name = 'io_capabilities'
  readonly readonly = true
  readonly supportsRemoteWorkdir = false
  readonly description = `Discover Shadow's built-in audio recording, microphone, camera/video, screen capture, file input and interactive form capabilities. Use this for in-app capture instead of launching a separate browser. Connect the panel to an arbitrary-language service started with existing exec/process tools; no inline program or sink graph. Availability is not permission. Read ${IO_GUIDE} for the small WebSocket protocol.`
  readonly parameters: ToolParameters = { type: 'object', properties: {}, additionalProperties: false }

  constructor(private readonly broker: IoBroker, private readonly projectId: string) {}

  async execute(args: Record<string, unknown>, context: IoToolContext): Promise<string> {
    assertIoContext(this.broker, this.projectId, context)
    z.object({}).strict().parse(args)
    const capabilities = this.broker.capabilities()
    return JSON.stringify({
      status: capabilities.clients.length ? 'available' : 'needs_client',
      clients: capabilities.clients.map(client => ({
        ...client,
        capabilities: client.capabilities.filter(capability => capability.kind === 'source' &&
          ['microphone', 'camera', 'screen', 'file', 'form'].includes(capability.id)),
      })),
      limits: capabilities.limits,
      schema: {
        version: 1, guide: IO_GUIDE,
        sources: ['microphone', 'camera', 'screen', 'file', 'form'],
        uiNodes: ['column', 'row', 'text', 'button', 'input', 'select', 'table', 'canvas', 'media'],
        definition: 'version, title, purpose, endpoint:loopback ws/wss URL, sources, limits:{durationMs,maxBytes}, ui?',
        protocol: 'shadow.io.v1: open/ready; event+sequence/ack; backend ui,preview,status,artifact,done,error messages',
        authorization: 'Only a user gesture in the trusted host can start a run; no agent approval tool exists.',
      },
    })
  }
}

export class IoRunTool implements Tool {
  readonly name = 'io_run'
  readonly supportsRemoteWorkdir = false
  readonly readonly = (args: Record<string, unknown>) => ['get', 'status', 'list', 'outputs'].includes(String(args.action))
  readonly description = `Connect a finite, immutable frontend I/O panel to an already-started local WebSocket service, inspect this session's runs or cancel the link. Use existing exec/process tools for service lifecycle; stop does not kill that process. Human Start is required for browser capture. No inline program, sink graph or approval action. Read ${IO_GUIDE} for open/ready, event/ack and backend-driven UI. Outputs returns paged registered file handles.`
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'get', 'status', 'list', 'stop', 'outputs'] },
      definition: { type: 'object', description: `Required for create: {version:1,title,purpose,endpoint:"ws://127.0.0.1:8765",sources,limits:{durationMs:1000..86400000,maxBytes:1024..1073741824},ui?}. Start the service with existing exec first. Protocol: ${IO_GUIDE}.` },
      id: { type: 'string', description: 'Run UUID returned by create/list; required except create/list.' },
      includeDefinition: { type: 'boolean', description: 'get/status only: explicitly include the complete immutable definition; defaults false.' },
      offset: { type: 'number', description: 'outputs only: zero-based artifact offset, default 0.' },
      limit: { type: 'number', description: 'outputs only: 1..100 handles, default 25.' },
    },
    required: ['action'], additionalProperties: false,
  }

  constructor(private readonly broker: IoBroker, private readonly projectId: string) {}

  async execute(args: Record<string, unknown>, context: IoToolContext): Promise<string> {
    assertIoContext(this.broker, this.projectId, context)
    const input = runArguments.parse(args)
    if (input.action === 'create') return JSON.stringify(ioRunHandle(await createIoRun(this.broker, input.definition, context)))
    if (input.action === 'list') return JSON.stringify({
      runs: this.broker.list(context.sessionId).map(run => ({
        id: run.id, revision: run.revision, title: run.definition.title, status: run.status,
        createdAt: run.createdAt, finishedAt: run.finishedAt, bytes: run.bytes, artifactCount: run.artifacts.length,
        backendStatus: run.backendStatus,
      })),
    })
    const run = this.broker.get(input.id, context.sessionId)
    if (input.action === 'stop') {
      const stopped = await this.broker.stop(run.id, 'cancelled', 'Stopped by the owning agent session')
      context.signal.throwIfAborted()
      return JSON.stringify(ioRunHandle(stopped))
    }
    if (input.action === 'outputs') {
      const offset = input.offset ?? 0
      const limit = input.limit ?? 25
      const artifacts = run.artifacts.slice(offset, offset + limit)
      return JSON.stringify({ id: run.id, status: run.status, total: run.artifacts.length, artifacts,
        nextOffset: offset + artifacts.length < run.artifacts.length ? offset + artifacts.length : null })
    }
    return JSON.stringify({ ...ioRunHandle(run), ...(input.includeDefinition ? { definition: run.definition } : {}) })
  }
}
