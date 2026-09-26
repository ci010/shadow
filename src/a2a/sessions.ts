import { z } from 'zod'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualEntry, VirtualListOptions } from '../vfs/virtual-fs.ts'
import { A2aClientTools, remoteExecutionId, remoteSessionId, remoteInputRequest } from './client.ts'
import type { A2aConfig } from './config.ts'
import type { A2aStore, OutboundCall } from './store.ts'

const id = z.string().uuid()
const terminal = (call: OutboundCall) => ['completed', 'failed', 'cancelled', 'rejected'].includes(call.status)

/** Remote references are views of the A2A journal, never executable local sessions. */
export class A2aSessions {
  constructor(
    private readonly projectId: string,
    private readonly config: A2aConfig,
    private readonly store: A2aStore,
    private readonly client: A2aClientTools,
    private readonly assertOwner: (context: ExecutionContext) => void,
  ) {}

  private authorize(context: ExecutionContext, tool: string): void {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId) throw new Error('Remote session belongs to another Project.')
    this.assertOwner(context)
    if (context.remoteWorkdir) throw new Error('A2A session operations do not support remote workdirs.')
    if (context.tools.executionMode === 'call') throw new Error('Leaf calls cannot coordinate remote sessions.')
    if (!context.tools.canUseDynamic(tool)) throw new Error(`Remote session access requires permission for ${tool}.`)
  }

  agents(context: ExecutionContext) {
    this.authorize(context, 'a2a_agents')
    return Object.keys(this.config.agents).map(name => ({
      name: `a2a:${name}`, kind: 'remote', protocol: 'a2a', modes: ['task'],
      description: 'Operator-configured external text agent; no local files, role, or work context is inherited.',
    }))
  }

  start(agentType: string, task: string, context: ExecutionContext): Promise<string> {
    this.authorize(context, 'a2a_send')
    if (!agentType.startsWith('a2a:')) throw new Error('Expected an A2A agent reference from v:agents.')
    return this.client.call('a2a_send', { agent: agentType.slice(4), message: task }, context)
  }

  private conversation(sessionId: string, context: ExecutionContext): OutboundCall[] {
    if (!sessionId.startsWith('remote:')) throw new Error('Expected a remote session reference.')
    id.parse(sessionId.slice(7))
    const calls = [...this.store.outbound.values()].filter(call =>
      call.owner === context.sessionId && remoteSessionId(call) === sessionId)
    if (!calls.length) throw new Error('Unknown remote session for this owner.')
    for (const call of calls) {
      if (this.config.agents[call.agent]?.endpointUrl !== call.endpointUrl) {
        throw new Error('Remote agent configuration changed; this conversation cannot be reused.')
      }
    }
    return calls
  }

  private latest(calls: OutboundCall[]): OutboundCall {
    const replaced = new Set(calls.flatMap(call => [call.previous, call.replyTo]).filter(Boolean))
    const heads = calls.filter(call => !replaced.has(call.id))
    if (heads.length !== 1) throw new Error('Remote conversation has ambiguous execution history; inspect its execution records.')
    return heads[0]
  }

  private summary(call: OutboundCall) {
    return {
      sessionId: remoteSessionId(call), executionId: remoteExecutionId(call),
      agentType: `a2a:${call.agent}`, handle: call.id, status: call.status,
      notification: call.notification, trackingError: call.trackingError,
      notificationError: call.notificationError,
      request: remoteInputRequest(call),
    }
  }

  async message(sessionId: string, content: string, context: ExecutionContext): Promise<string> {
    this.authorize(context, 'a2a_send')
    const calls = this.conversation(sessionId, context)
    const key = context.toolCallId && JSON.stringify([
      context.sessionId, context.physicalSessionId, context.messageId, context.toolCallId,
    ])
    const replay = key ? [...this.store.outbound.values()].find(call => call.key === key) : undefined
    if (replay && (remoteSessionId(replay) !== sessionId || !replay.previous)) {
      throw new Error('This invocation was already used for a different remote operation.')
    }
    const previous = replay
      ? calls.find(call => call.id === replay.previous)
      : this.latest(calls)
    if (!previous) throw new Error('Remote message predecessor is missing.')
    if (!replay && !terminal(previous)) {
      throw new Error(previous.status === 'input-required'
        ? 'Remote task needs input. Read its pending request and answer with reply(request_id, text).'
        : 'Remote conversation is still active or its outcome is uncertain; inspect it before sending more work.')
    }
    const args = { agent: previous.agent, message: content, context: previous.id }
    const tool = this.client.tools().find(tool => tool.name === 'a2a_send')!
    const admission = context.tools.getWorkGuard()?.before(tool, args, context)
    let result: string
    try { result = await this.client.call('a2a_send', args, context) }
    catch (error) { admission?.finish(true); throw error }
    const notice = admission?.finish(false)
    return notice ? JSON.stringify({ ...JSON.parse(result), notice }) : result
  }

  async cancel(executionId: string, context: ExecutionContext): Promise<string> {
    this.authorize(context, 'a2a_cancel')
    const match = /^(remote:[^/]+)\/executions\/([^/]+)$/.exec(executionId)
    if (!match) throw new Error('Cancel requires an executionId, not a remote conversation ID.')
    const call = this.conversation(match[1], context).find(call => call.id === id.parse(match[2]))
    if (!call) throw new Error('Unknown remote execution for this conversation.')
    return this.client.call('a2a_cancel', { handle: call.id }, context)
  }

  async reply(requestId: string, text: string, context: ExecutionContext): Promise<string> {
    this.authorize(context, 'a2a_send')
    this.conversation(requestId.split('/')[0], context)
    const work = context.tools.getWorkGuard()
    if (context.workStamps?.length && work?.current(context.workStamps) === false) {
      throw new Error('Work basis changed; inspect the current input before replying remotely.')
    }
    const tool = this.client.tools().find(tool => tool.name === 'a2a_send')!
    const admission = work?.before(tool, { message: text }, context)
    let result: string
    try { result = await this.client.call('reply', { request_id: requestId, text }, context) }
    catch (error) { admission?.finish(true); throw error }
    const notice = admission?.finish(false)
    return notice ? JSON.stringify({ ...JSON.parse(result), notice }) : result
  }

  async read(path: string, context: ExecutionContext): Promise<string> {
    this.authorize(context, 'a2a_get')
    const [sessionId, kind, handle, ...extra] = path.split('/')
    if (extra.length || kind !== undefined && kind !== 'executions') throw new Error('Unknown remote session resource.')
    const calls = this.conversation(sessionId, context)
    if (kind === 'executions' && !handle) return JSON.stringify(calls.map(call => this.summary(call)), null, 2)
    const call = handle ? calls.find(call => call.id === id.parse(handle)) : this.latest(calls)
    if (!call) throw new Error('Unknown remote execution for this conversation.')
    const result = await this.client.call('a2a_get', { handle: call.id }, context)
    return JSON.stringify({ ...JSON.parse(result), ...this.summary(this.store.outbound.get(call.id)!) }, null, 2)
  }

  entries(context: ExecutionContext, options?: VirtualListOptions): VirtualEntry[] {
    this.authorize(context, 'a2a_calls')
    const groups = new Map<string, OutboundCall[]>()
    for (const call of this.store.outbound.values()) {
      if (call.owner !== context.sessionId) continue
      const key = remoteSessionId(call)
      const group = groups.get(key) ?? []
      group.push(call)
      groups.set(key, group)
    }
    const entries = new Map<string, VirtualEntry>()
    const add = (name: string, value: unknown) => {
      if (options?.subpath && name !== options.subpath && !name.startsWith(`${options.subpath}/`)) return
      entries.set(name, { name, content: options?.content === false ? '' : JSON.stringify(value, null, 2) })
    }
    for (const [sessionId, group] of groups) {
      const replaced = new Set(group.flatMap(call => [call.previous, call.replyTo]))
      const heads = group.filter(call => !replaced.has(call.id))
      add(sessionId, { sessionId, kind: 'remote', executions: heads.map(call => this.summary(call)) })
      add(`${sessionId}/executions`, group.map(call => this.summary(call)))
      for (const call of group) add(remoteExecutionId(call), this.summary(call))
    }
    return [...entries.values()]
  }

  canDiscover(context: ExecutionContext, tool = 'a2a_calls'): boolean {
    return !context.remoteWorkdir && (context.tools.executionMode === undefined || context.tools.executionMode === 'session') &&
      context.tools.canUseDynamic(tool)
  }
}
