import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AgentCard, CancelTaskRequest, GetTaskRequest, Message, Role, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk'
import { ClientFactory, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolParameters } from '../tools/tool.ts'
import { resolveA2aSecret, type A2aConfig } from './config.ts'
import { A2aStore, type OutboundCall } from './store.ts'
import { fingerprint, textPart } from './service.ts'

const sendSchema = z.object({
  agent: z.string().min(1).max(64), message: z.string().min(1).max(64 * 1024),
  context: z.string().uuid().optional(),
}).strict()
const handleSchema = z.object({ handle: z.string().uuid() }).strict()
const replySchema = z.object({
  request_id: z.string().regex(/^remote:[^/]+\/executions\/[^/]+\/input\/[a-f0-9]{64}$/),
  text: z.string().min(1).max(64 * 1024),
}).strict()
const finishedCall = (call: OutboundCall): boolean => ['completed', 'failed', 'cancelled', 'rejected'].includes(call.status)
const needsAttention = (call: OutboundCall): boolean => finishedCall(call) || ['input-required', 'auth-required'].includes(call.status)
export type A2aCallContext = Pick<ExecutionContext, 'projectId' | 'sessionId' | 'physicalSessionId' | 'messageId' | 'toolCallId' | 'signal'>
export const remoteSessionId = (call: OutboundCall): string => `remote:${call.conversationId ?? call.id}`
export const remoteExecutionId = (call: OutboundCall): string => `${remoteSessionId(call)}/executions/${call.id}`
export function remoteInputRequest(call: OutboundCall) {
  if (call.status !== 'input-required') return undefined
  const message = Task.fromJSON(call.result).status?.message
  return {
    kind: 'input' as const,
    request_id: `${remoteExecutionId(call)}/input/${fingerprint(message ? Message.toJSON(message) : null)}`,
    question: message?.parts.filter(part => part.content?.$case === 'text').map(part => part.content!.value).join('\n') ?? '',
  }
}
export interface A2aClientLifecycle {
  notify(call: OutboundCall, content: string): Promise<void>
}

/** Exact operator-configured URLs, no redirects, cookies, ambient credentials or URL discovery. */
export function a2aFetch(config: A2aConfig['agents'][string], signal: AbortSignal, token?: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!((url.href === config.cardUrl && method === 'GET') || (url.href === config.endpointUrl && method === 'POST'))) {
      throw new Error('A2A attempted to contact an unapproved endpoint.')
    }
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(url, {
      ...init, method, headers, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    })
    // Polling uses bounded responses rather than holding one stream per remote task.
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (reader) while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > 1024 * 1024) throw new Error('A2A response exceeds 1 MiB.')
        chunks.push(item.value)
      }
    } catch (error) { await reader?.cancel(); throw error }
    finally { reader?.releaseLock() }
    return new Response(response.status === 204 || response.status === 304 ? null : Buffer.concat(chunks), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })
  }
}

export class A2aClientTools {
  private readonly controller = new AbortController()
  private readonly requests = new Set<Promise<unknown>>()
  private readonly tokens = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private polling?: Promise<void>
  private cursor = 0

  constructor(
    private readonly projectId: string,
    private readonly config: A2aConfig,
    private readonly store: A2aStore,
    private readonly lifecycle?: A2aClientLifecycle,
  ) {
    for (const [name, agent] of Object.entries(config.agents)) {
      if (agent.tokenEnv) this.tokens.set(name, resolveA2aSecret(agent.tokenEnv))
    }
    for (const call of store.outbound.values()) {
      if (call.status === 'sending') store.saveCall({ ...call, status: 'uncertain' })
      if (call.notification === 'delivering') store.saveCall({
        ...store.outbound.get(call.id)!, notification: 'uncertain',
        notificationError: 'Notification acceptance was interrupted; not automatically redelivered.',
      })
    }
  }

  setLocalToken(name: string, token?: string): void {
    if (token) this.tokens.set(name, token)
    else this.tokens.delete(name)
  }

  private async client(name: string, signal: AbortSignal): Promise<Client> {
    if (!Object.hasOwn(this.config.agents, name)) throw new Error('Unknown configured A2A agent.')
    const agent = this.config.agents[name]
    const fetchImpl = a2aFetch(agent, signal, this.tokens.get(name))
    const response = await fetchImpl(agent.cardUrl, { headers: { 'A2A-Version': '1.0' } })
    if (!response.ok) throw new Error(`A2A discovery failed (HTTP ${response.status}).`)
    const card = AgentCard.fromJSON(await response.json())
    const interfaces = card.supportedInterfaces.filter(value => value.url === agent.endpointUrl &&
      value.protocolBinding === 'JSONRPC' && value.protocolVersion === '1.0')
    if (!interfaces.length) throw new Error('Agent Card does not advertise the approved A2A 1.0 JSON-RPC endpoint.')
    if (card.capabilities?.extensions.some(extension => extension.required)) throw new Error('Remote agent requires unsupported extensions.')
    return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] })
      .createFromAgentCard({ ...card, supportedInterfaces: interfaces })
  }

  private owned(handle: string, context: A2aCallContext): OutboundCall {
    const call = this.store.outbound.get(handle)
    if (!call || call.owner !== context.sessionId) throw new Error('Unknown A2A call for this session.')
    if (this.config.agents[call.agent]?.endpointUrl !== call.endpointUrl) throw new Error('A2A agent endpoint changed; cannot reuse this call.')
    return structuredClone(call)
  }

  private result(call: OutboundCall): string {
    return JSON.stringify({
      sessionId: remoteSessionId(call), executionId: remoteExecutionId(call),
      handle: call.id, agent: call.agent, status: call.status,
      taskId: call.taskId, contextId: call.contextId, result: call.result,
      trackingError: call.trackingError, notification: call.notification, notificationError: call.notificationError,
      request: remoteInputRequest(call),
      ...(call.status === 'uncertain' ? { error: 'Delivery outcome is unknown. Do not automatically retry; remote effects may have occurred.' } : {}),
    })
  }

  private saveResult(call: OutboundCall, result: Message | Task): string {
    const current = this.store.outbound.get(call.id)
    // An older in-flight query must not overwrite a cancellation or final result.
    if (current && finishedCall(current)) return this.result(current)
    if (!result.contextId || result.contextId.length > 512) throw new Error('Remote agent returned an invalid contextId.')
    if (call.contextId && call.contextId !== result.contextId) throw new Error('Remote agent changed the call contextId.')
    if ('id' in result && (!result.id || result.id.length > 512 || call.taskId && call.taskId !== result.id)) {
      throw new Error('Remote agent returned an invalid or different taskId.')
    }
    call.contextId = result.contextId || undefined
    if ('id' in result) {
      if (!result.status || ![
        TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
      ].includes(result.status.state)) throw new Error('Remote agent returned an invalid task state.')
      call.taskId = result.id
      call.status = result.status.state === TaskState.TASK_STATE_COMPLETED ? 'completed'
        : result.status.state === TaskState.TASK_STATE_FAILED ? 'failed'
        : result.status.state === TaskState.TASK_STATE_CANCELED ? 'cancelled'
        : result.status.state === TaskState.TASK_STATE_REJECTED ? 'rejected'
        : result.status.state === TaskState.TASK_STATE_INPUT_REQUIRED ? 'input-required'
        : result.status.state === TaskState.TASK_STATE_AUTH_REQUIRED ? 'auth-required' : 'submitted'
      call.result = Task.toJSON(result)
    } else {
      call.status = 'completed'
      call.result = Message.toJSON(result)
    }
    call.trackingError = undefined
    const revision = fingerprint([call.status, call.result])
    if (this.lifecycle && needsAttention(call) && revision !== current?.notificationRevision) {
      call.notification = 'pending'
      call.notificationRevision = revision
      call.notificationError = undefined
    } else if (current) {
      call.notification = current.notification
      call.notificationRevision = current.notificationRevision
      call.notificationError = current.notificationError
    }
    this.store.saveCall(call)
    return this.result(call)
  }

  private async execute(operation: string, args: Record<string, unknown>, context: A2aCallContext): Promise<string> {
    if (context.projectId !== this.projectId) throw new Error('A2A tool belongs to another Project.')
    this.controller.signal.throwIfAborted()
    const signal = AbortSignal.any([context.signal, this.controller.signal, AbortSignal.timeout(30_000)])
    if (operation === 'agents') {
      z.object({}).strict().parse(args)
      return JSON.stringify(Object.keys(this.config.agents).map(name => ({ agent: name })))
    }
    if (operation === 'calls') {
      z.object({}).strict().parse(args)
      return JSON.stringify([...this.store.outbound.values()].filter(call => call.owner === context.sessionId)
        .map(call => ({ handle: call.id, agent: call.agent, status: call.status, notification: call.notification, trackingError: call.trackingError })))
    }
    if (operation !== 'send' && operation !== 'reply') {
      const call = this.owned(handleSchema.parse(args).handle, context)
      if (finishedCall(call)) {
        if (operation === 'cancel') throw new Error('A2A call is already terminal and cannot be canceled.')
        return this.result(call)
      }
      if (!call.taskId) {
        if (operation === 'cancel') throw new Error('No remote task ID is known; cancellation cannot be confirmed.')
        return this.result(call)
      }
      const client = await this.client(call.agent, signal)
      const result = operation === 'cancel'
        ? await client.cancelTask(CancelTaskRequest.fromJSON({ id: call.taskId }), { signal })
        : await client.getTask(GetTaskRequest.fromJSON({ id: call.taskId }), { signal })
      return this.saveResult(call, result)
    }
    const reply = operation === 'reply' ? replySchema.parse(args) : undefined
    const replying = reply ? this.owned(reply.request_id.split('/')[2], context) : undefined
    const input = reply ? { agent: replying!.agent, message: reply.text, context: replying!.id } : sendSchema.parse(args)
    if (!Object.hasOwn(this.config.agents, input.agent)) throw new Error('Unknown configured A2A agent.')
    if (!input.message.trim() || Buffer.byteLength(input.message) > 64 * 1024) throw new Error('A2A text must contain 1-65536 bytes.')
    const agent = this.config.agents[input.agent]
    const previous = input.context ? this.owned(input.context, context) : undefined
    if (previous && (previous.agent !== input.agent || !previous.contextId)) throw new Error('Context must reference a call to the same remote agent with a known contextId.')
    const key = JSON.stringify([context.sessionId, context.physicalSessionId, context.messageId, context.toolCallId ?? randomUUID()])
    const hash = fingerprint(reply ? ['reply', reply] : input)
    const duplicate = [...this.store.outbound.values()].find(call => call.key === key)
    if (duplicate) {
      if (duplicate.fingerprint !== hash) throw new Error('A2A invocation was already used with different arguments.')
      return this.result(duplicate)
    }
    const assertPendingInput = () => {
      if (!replying || !reply) return
      const current = this.owned(replying.id, context)
      if (!current.taskId || remoteInputRequest(current)?.request_id !== reply.request_id) {
        throw new Error('Input request changed or is no longer pending. Inspect the current request; authentication is not an input reply.')
      }
    }
    assertPendingInput()
    if (!replying && previous && !finishedCall(previous)) throw new Error('Context is still active. Use reply for requested input, or wait for completion.')
    if (replying && [...this.store.outbound.values()].some(call => call.replyTo === replying.id)) {
      throw new Error('This input already has a reply; follow its returned handle instead of resending.')
    }
    const assertContextIdle = () => {
      if (!previous || replying) return
      const superseded = new Set([...this.store.outbound.values()].map(call => call.replyTo))
      if ([...this.store.outbound.values()].some(call => call.owner === context.sessionId &&
        call.agent === input.agent && call.contextId === previous.contextId &&
        !finishedCall(call) && !superseded.has(call.id))) {
        throw new Error('Context is still active. Wait for completion or answer the pending input with reply.')
      }
    }
    assertContextIdle()
    // Discovery can fail safely before reserving a delivery.
    const client = await this.client(input.agent, signal)
    // Concurrent duplicate invocations may have completed discovery together.
    const admitted = [...this.store.outbound.values()].find(call => call.key === key)
    if (admitted) {
      if (admitted.fingerprint !== hash) throw new Error('A2A invocation was already used with different arguments.')
      return this.result(admitted)
    }
    if (replying && [...this.store.outbound.values()].some(call => call.replyTo === replying.id)) {
      throw new Error('This input already has a reply; follow its returned handle instead of resending.')
    }
    assertContextIdle()
    assertPendingInput()
    const call: OutboundCall = {
      version: 1, id: randomUUID(), owner: context.sessionId, agent: input.agent, key, fingerprint: hash,
      messageId: randomUUID(), endpointUrl: agent.endpointUrl, status: 'sending', contextId: previous?.contextId,
      taskId: replying?.taskId, replyTo: replying?.id,
    }
    call.conversationId = previous?.conversationId ?? previous?.id ?? call.id
    call.previous = previous?.id
    this.store.saveCall(call)
    try {
      const request: SendMessageRequest = {
        tenant: '', metadata: undefined,
        message: {
          messageId: call.messageId, role: Role.ROLE_USER, contextId: call.contextId ?? '',
          parts: [textPart(input.message)], taskId: call.taskId ?? '', extensions: [], referenceTaskIds: [], metadata: undefined,
        },
        configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain'], taskPushNotificationConfig: undefined },
      }
      const result = await client.sendMessage(request, { signal })
      return this.saveResult(call, result)
    } catch (error) {
      this.store.saveCall({ ...call, status: 'uncertain' })
      console.error('[a2a] Outbound delivery outcome uncertain', { handle: call.id, agent: call.agent })
      throw new Error(`A2A delivery outcome is unknown (handle ${call.id}). Do not automatically retry.`, { cause: error })
    }
  }

  tools(): Tool[] {
    return ['agents', 'calls', 'send', 'reply', 'get', 'cancel'].map((operation): Tool => {
      const properties: ToolParameters['properties'] = operation === 'send' ? {
        agent: { type: 'string' }, message: { type: 'string' }, context: { type: 'string' },
      } : operation === 'reply' ? { request_id: { type: 'string' }, text: { type: 'string' } }
        : operation === 'agents' || operation === 'calls' ? {} : { handle: { type: 'string' } }
      return {
        name: operation === 'reply' ? 'reply' : `a2a_${operation}`,
        description: operation === 'agents' ? 'List configured remote A2A agents.'
          : operation === 'calls' ? 'Recover this session\'s durable A2A call handles and statuses after interruption.'
          : operation === 'reply' ? 'Answer a remote task waiting for input. Returns a new durable handle to follow. This is not authorization to grant permissions or forward credentials.'
          : operation === 'send' ? 'Send only explicitly selected text to a configured external agent. Returns a durable handle; completion or requested input is delivered asynchronously in Shadow. Context is an earlier local handle, not a remote ID.'
          : operation === 'get' ? 'Refresh a remote A2A task by its local handle. Reports completion, failure or cancellation explicitly.'
          : 'Request cancellation of a remote A2A task by its local handle. Existing side effects are not rolled back.',
        parameters: {
          type: 'object',
          properties,
          required: operation === 'send' ? ['agent', 'message'] : operation === 'reply' ? ['request_id', 'text']
            : operation === 'agents' || operation === 'calls' ? [] : ['handle'],
          additionalProperties: false,
        },
        execute: (args, context) => {
          return this.call(operation === 'reply' ? 'reply' : `a2a_${operation}`, args, context)
        },
      }
    })
  }

  call(name: string, args: Record<string, unknown>, context: A2aCallContext): Promise<string> {
    if (!['a2a_agents', 'a2a_calls', 'a2a_send', 'reply', 'a2a_get', 'a2a_cancel'].includes(name)) return Promise.reject(new Error('Unknown A2A tool.'))
    const pending = this.execute(name === 'reply' ? 'reply' : name.slice(4), args, context)
    this.requests.add(pending)
    void pending.then(() => this.requests.delete(pending), () => this.requests.delete(pending))
    return pending
  }

  start(): void {
    this.controller.signal.throwIfAborted()
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.poll().catch(error => console.error('[a2a] Background tracking failed', error))
    }, 2000)
    this.timer.unref()
  }

  /** One bounded batch; no submissions or uncertain notification deliveries are replayed. */
  poll(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.pollBatch().finally(() => { this.polling = undefined })
    return this.polling
  }

  private async pollBatch(): Promise<void> {
    if (this.controller.signal.aborted) return
    const superseded = new Set([...this.store.outbound.values()].map(call => call.replyTo).filter(Boolean))
    const candidates = [...this.store.outbound.values()].filter(call => !superseded.has(call.id) &&
      (call.notification === 'pending' || call.taskId && call.status !== 'sending' && !finishedCall(call)))
    if (!candidates.length) return
    const batch = Array.from({ length: Math.min(4, candidates.length) }, (_, i) => candidates[(this.cursor + i) % candidates.length])
    this.cursor = (this.cursor + batch.length) % candidates.length
    await Promise.all(batch.map(async snapshot => {
      try {
        let call = this.store.outbound.get(snapshot.id)!
        if (call.taskId && call.status !== 'sending' && !finishedCall(call)) {
          const context: A2aCallContext = {
            projectId: this.projectId, sessionId: call.owner, physicalSessionId: '', messageId: '', signal: this.controller.signal,
          }
          await this.execute('get', { handle: call.id }, context)
          call = this.store.outbound.get(call.id)!
        }
        if (this.lifecycle && call.notification === 'pending' && !this.controller.signal.aborted) {
          this.store.saveCall({ ...call, notification: 'delivering' })
          try {
            await this.lifecycle.notify(structuredClone(call), this.result(call))
            const latest = this.store.outbound.get(call.id)!
            if (latest.notificationRevision === call.notificationRevision) this.store.saveCall({ ...latest, notification: 'delivered' })
          } catch (error) {
            const latest = this.store.outbound.get(call.id)!
            if (latest.notificationRevision === call.notificationRevision) this.store.saveCall({
              ...latest, notification: 'uncertain', notificationError: 'Notification acceptance failed; inspect this handle manually.',
            })
            throw error
          }
        }
      } catch (error) {
        if (this.controller.signal.aborted) return
        const latest = this.store.outbound.get(snapshot.id)!
        if (!latest.trackingError) console.error('[a2a] Could not track or notify remote task', { handle: snapshot.id }, error)
        this.store.saveCall({ ...latest, trackingError: 'Background refresh or notification failed. Use a2a_get for diagnostics; execution was not resubmitted.' })
      }
    }))
  }

  async close(): Promise<void> {
    this.controller.abort()
    clearInterval(this.timer)
    await Promise.allSettled(this.requests)
    await this.polling
  }
}
