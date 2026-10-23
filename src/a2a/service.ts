import { createHash, randomUUID } from 'node:crypto'
import { AgentCard, Message, Role, Task, TaskState, type StreamResponse, type Part,
  type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest, type ListTasksRequest,
  type SubscribeToTaskRequest, type ListTasksResponse } from '@a2a-js/sdk'
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server'
import { ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError,
  RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import type { SessionTurnFact } from '../sessions/input.ts'
import { A2aStore, terminal, interrupted, type InboundTask } from './store.ts'
import type { A2aConfig } from './config.ts'

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const textPart = (text: string): Part => ({
  content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined,
})
export const textMessage = (text: string, taskId = '', contextId = ''): Message => ({
  messageId: randomUUID(), role: Role.ROLE_AGENT, taskId, contextId,
  parts: [textPart(text)], metadata: undefined, extensions: [], referenceTaskIds: [],
})
export interface A2aRunner {
  run(record: InboundTask, message: Message, signal: AbortSignal, interaction: A2aInteraction): Promise<Pick<SessionTurnFact, 'status' | 'content'>>
}
export interface A2aInteraction {
  ask(question: string, signal?: AbortSignal): Promise<string>
}
type Running = { controller: AbortController; promise: Promise<void> }

/** Owns admission and persistence; the SDK owns JSON-RPC and ProtoJSON conversion. */
export class A2aService implements A2ARequestHandler {
  private readonly running = new Map<string, Running>()
  private readonly observers = new Set<() => void>()
  private readonly questions = new Map<string, (message: Message) => void>()
  private stopped = false
  private failure?: Error
  private readonly card: AgentCard

  constructor(
    private readonly projectId: string,
    private readonly config: NonNullable<A2aConfig['server']>,
    private readonly store: A2aStore,
    private readonly runner: A2aRunner,
  ) {
    this.card = AgentCard.fromJSON({
      name: 'Shadow', description: 'Project-scoped text agent for trusted callers.',
      version: '1.0.0',
      supportedInterfaces: [{ url: config.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: projectId }],
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: [] } }],
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: [{ id: 'text', name: 'Text tasks', description: 'Submit a text task to the configured Project agent.', tags: ['text'] }],
    })
    for (const record of store.inbound.values()) {
      if (!terminal(record.task)) this.finish(record, TaskState.TASK_STATE_FAILED, 'Execution interrupted by restart; not replayed. Partial effects may have occurred.')
    }
  }

  async getAgentCard(): Promise<AgentCard> { return structuredClone(this.card) }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError() }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError() }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError() }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError() }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError() }

  private owner(context: ServerCallContext, tenant: string): string {
    if (!context.user?.isAuthenticated || !context.user.userName || (tenant && tenant !== this.projectId)) {
      throw new RequestMalformedError('Invalid authenticated project scope.')
    }
    return context.user.userName
  }

  private find(id: string, context: ServerCallContext, tenant: string): InboundTask {
    const owner = this.owner(context, tenant)
    const record = this.store.inbound.get(id)
    if (!record || record.owner !== owner) throw new TaskNotFoundError()
    return structuredClone(record)
  }

  private snapshot(value: Task, length?: number): Task {
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new RequestMalformedError('Invalid historyLength.')
    const task = structuredClone(value)
    if (length !== undefined) task.history = length === 0 ? [] : task.history.slice(-length)
    return task
  }

  private admit(params: SendMessageRequest, context: ServerCallContext): InboundTask {
    if (this.stopped || this.failure) throw new UnsupportedOperationError('A2A service is unavailable.')
    const owner = this.owner(context, params.tenant)
    const message = params.message
    if (!message || message.role !== Role.ROLE_USER || !message.messageId || message.messageId.length > 256 ||
      !message.parts.length || message.parts.length > 32) throw new RequestMalformedError('A user message with messageId and text parts is required.')
    if (message.parts.some(part => part.content?.$case !== 'text' || part.mediaType && part.mediaType !== 'text/plain')) {
      throw new ContentTypeNotSupportedError('Only text/plain parts are supported.')
    }
    const content = message.parts.map(part => part.content?.value).join('\n')
    if (!content.trim() || Buffer.byteLength(content) > 64 * 1024) throw new RequestMalformedError('Text must contain 1-65536 bytes.')
    if (message.extensions.length || message.referenceTaskIds.length || message.metadata || params.metadata) {
      throw new UnsupportedOperationError('Extensions, references and metadata are not supported.')
    }
    if (params.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError()
    if (params.configuration?.acceptedOutputModes.length && !params.configuration.acceptedOutputModes.includes('text/plain')) {
      throw new ContentTypeNotSupportedError()
    }
    const length = params.configuration?.historyLength
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new RequestMalformedError('Invalid historyLength.')
    const hash = fingerprint(Message.toJSON(message))
    const duplicate = [...this.store.inbound.values()].find(record => record.owner === owner &&
      (record.messageId === message.messageId || record.replies?.some(reply => reply.messageId === message.messageId)))
    if (duplicate) {
      const receipt = duplicate.messageId === message.messageId ? duplicate : duplicate.replies!.find(reply => reply.messageId === message.messageId)!
      if (receipt.fingerprint !== hash) throw new RequestMalformedError('messageId was already used with different content.')
      return structuredClone(duplicate)
    }
    if (message.taskId) {
      const record = this.find(message.taskId, context, params.tenant)
      if (message.contextId && message.contextId !== record.task.contextId) throw new RequestMalformedError('Task contextId does not match.')
      const answer = this.questions.get(message.taskId)
      if (!interrupted(record.task) || !answer) throw new UnsupportedOperationError('Task is not waiting for input.')
      if ((record.replies?.length ?? 0) >= 64) throw new UnsupportedOperationError('Task input limit reached.')
      record.replies = [...record.replies ?? [], { messageId: message.messageId, fingerprint: hash }]
      record.task.history.push(message)
      record.task.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }
      this.store.saveTask(record)
      this.questions.delete(message.taskId)
      answer(message)
      this.notify()
      return record
    }
    let previous: InboundTask | undefined
    if (message.contextId) {
      previous = [...this.store.inbound.values()].find(record => record.owner === owner && record.task.contextId === message.contextId)
      if (!previous) throw new RequestMalformedError('Unknown contextId.')
      if ([...this.store.inbound.values()].some(record => record.task.contextId === message.contextId && !terminal(record.task))) {
        throw new UnsupportedOperationError('This context already has an active task.')
      }
    }
    if (this.running.size >= this.config.maxConcurrent) throw new UnsupportedOperationError('A2A concurrency limit reached.')
    const task: Task = {
      id: randomUUID(), contextId: previous?.task.contextId ?? randomUUID(),
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      history: [message], artifacts: [], metadata: undefined,
    }
    const record: InboundTask = {
      version: 1, owner, sessionId: previous?.sessionId ?? `a2a:${randomUUID()}`,
      messageId: message.messageId, fingerprint: hash, task,
    }
    this.store.saveTask(record)
    const controller = new AbortController()
    // Reserve before yielding; duplicate requests and concurrent contexts cannot race admission.
    const promise = Promise.resolve().then(() => this.execute(record, message, controller))
    this.running.set(task.id, { controller, promise })
    void promise.catch(error => {
      this.failure = error instanceof Error ? error : new Error('A2A persistence failed.')
      console.error('[a2a] Task persistence failed; admissions disabled', error)
      this.notify()
    }).finally(() => this.running.delete(task.id))
    return record
  }

  private async execute(record: InboundTask, message: Message, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(new Error('A2A task deadline exceeded.')), this.config.timeoutMs)
    timer.unref()
    try {
      record.task.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }
      this.store.saveTask(record)
      this.notify()
      const result = await this.runner.run(record, message, controller.signal, {
        ask: (question, signal) => this.ask(record, question, controller.signal, signal),
      })
      if (Buffer.byteLength(result.content) > 256 * 1024) {
        this.finish(record, TaskState.TASK_STATE_FAILED, 'Result exceeds the 256 KiB text limit.')
      } else if (result.status === 'completed') {
        record.task.artifacts = [{
          artifactId: randomUUID(), name: 'result', description: '',
          parts: [textPart(result.content)], metadata: undefined, extensions: [],
        }]
        this.finish(record, TaskState.TASK_STATE_COMPLETED)
      } else {
        this.finish(record, result.status === 'cancelled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
          result.status === 'cancelled' ? 'Execution stopped. Partial effects may have occurred.' : 'Execution failed. Consult Project diagnostics.')
      }
    } catch (error) {
      if (controller.signal.aborted && error === controller.signal.reason) {
        this.finish(record, TaskState.TASK_STATE_CANCELED, 'Execution stopped. Partial effects may have occurred.')
      } else {
        console.error('[a2a] Task execution failed', error)
        this.finish(record, TaskState.TASK_STATE_FAILED, 'Execution failed. Partial effects may have occurred; consult Project diagnostics.')
      }
    } finally { clearTimeout(timer) }
  }

  private async ask(record: InboundTask, question: string, taskSignal: AbortSignal, questionSignal?: AbortSignal): Promise<string> {
    const signal = questionSignal ? AbortSignal.any([taskSignal, questionSignal]) : taskSignal
    signal.throwIfAborted()
    if (!question.trim() || Buffer.byteLength(question) > 64 * 1024) throw new Error('Invalid A2A question.')
    if (this.questions.has(record.task.id)) throw new Error('Only one input request per task may be pending.')
    const response = Promise.withResolvers<string>()
    const abort = () => {
      this.questions.delete(record.task.id)
      response.reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    this.questions.set(record.task.id, message => {
      const current = this.store.inbound.get(record.task.id)!
      record.replies = current.replies
      record.task = structuredClone(current.task)
      response.resolve(message.parts.map(part => part.content?.value).join('\n'))
    })
    try {
      record.task.status = {
        state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: new Date().toISOString(),
        message: textMessage(question, record.task.id, record.task.contextId),
      }
      this.store.saveTask(record)
      this.notify()
      return await response.promise
    } finally {
      signal.removeEventListener('abort', abort)
      this.questions.delete(record.task.id)
      if (questionSignal?.aborted && !taskSignal.aborted
        && record.task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
        record.task.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }
        this.store.saveTask(record)
        this.notify()
      }
    }
  }

  private finish(record: InboundTask, state: TaskState, reason?: string): void {
    record.task.status = {
      state, timestamp: new Date().toISOString(),
      message: reason ? textMessage(reason, record.task.id, record.task.contextId) : undefined,
    }
    this.store.saveTask(record)
    this.notify()
  }

  private notify(): void { for (const notify of this.observers) notify() }

  private async *watch(id: string, context: ServerCallContext, tenant: string, untilTerminal = false): AsyncGenerator<Task> {
    if (this.observers.size >= 128) throw new UnsupportedOperationError('Too many task subscribers.')
    const signal = context.state.get('signal')
    const abort = signal instanceof AbortSignal ? signal : undefined
    let changed = Promise.withResolvers<void>()
    const notify = () => changed.resolve()
    this.observers.add(notify)
    abort?.addEventListener('abort', notify, { once: true })
    let last = ''
    try {
      while (true) {
        abort?.throwIfAborted()
        if (this.failure) throw new UnsupportedOperationError('A2A persistence failed; consult Project diagnostics.')
        const task = this.find(id, context, tenant).task
        const revision = JSON.stringify(Task.toJSON(task))
        if (revision !== last) { last = revision; yield task }
        if (terminal(task) || !untilTerminal && interrupted(task)) return
        await changed.promise
        changed = Promise.withResolvers<void>()
      }
    } finally {
      this.observers.delete(notify)
      abort?.removeEventListener('abort', notify)
    }
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const record = this.admit(params, context)
    if (!params.configuration?.returnImmediately) {
      for await (const task of this.watch(record.task.id, context, params.tenant)) record.task = task
    }
    return this.snapshot(record.task, params.configuration?.historyLength)
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    const record = this.admit(params, context)
    yield* this.stream(record.task.id, context, params.tenant, params.configuration?.historyLength)
  }

  private async *stream(id: string, context: ServerCallContext, tenant: string, length?: number): AsyncGenerator<StreamResponse> {
    let first = true
    for await (const task of this.watch(id, context, tenant)) {
      if (first) {
        yield { payload: { $case: 'task', value: this.snapshot(task, length) } }
        first = false
      } else {
        for (const artifact of task.artifacts) {
          yield { payload: { $case: 'artifactUpdate', value: {
            taskId: task.id, contextId: task.contextId, artifact, append: false, lastChunk: true, metadata: undefined,
          } } }
        }
        yield { payload: { $case: 'statusUpdate', value: {
          taskId: task.id, contextId: task.contextId, status: task.status, metadata: undefined,
        } } }
      }
    }
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.snapshot(this.find(params.id, context, params.tenant).task, params.historyLength)
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const record = this.find(params.id, context, params.tenant)
    if (terminal(record.task)) throw new TaskNotCancelableError()
    const running = this.running.get(params.id)
    if (!running) throw new TaskNotCancelableError()
    running.controller.abort(new Error('A2A caller requested cancellation.'))
    // A request to abort is not proof of cancellation. The runner publishes the actual outcome.
    for await (const task of this.watch(params.id, context, params.tenant, true)) record.task = task
    return record.task
  }

  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    yield* this.stream(params.id, context, params.tenant)
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const owner = this.owner(context, params.tenant)
    const size = params.pageSize ?? 50
    if (!Number.isInteger(size) || size < 1 || size > 100 || params.pageToken && !/^\d{1,5}$/.test(params.pageToken)) throw new RequestMalformedError('Invalid pagination.')
    if (params.statusTimestampAfter && !Number.isFinite(Date.parse(params.statusTimestampAfter))) throw new RequestMalformedError('Invalid timestamp.')
    const offset = Number(params.pageToken || 0)
    const records = [...this.store.inbound.values()].filter(record => record.owner === owner &&
      (!params.contextId || record.task.contextId === params.contextId) &&
      (!params.status || record.task.status?.state === params.status) &&
      (!params.statusTimestampAfter || Date.parse(record.task.status!.timestamp!) >= Date.parse(params.statusTimestampAfter)))
      .sort((a, b) => a.task.id.localeCompare(b.task.id))
    const tasks = records.slice(offset, offset + size).map(record => {
      const task = this.snapshot(record.task, params.historyLength)
      if (!params.includeArtifacts) task.artifacts = []
      return task
    })
    return { tasks, pageSize: size, totalSize: records.length, nextPageToken: offset + size < records.length ? String(offset + size) : '' }
  }

  async close(): Promise<void> {
    this.stopped = true
    for (const running of this.running.values()) running.controller.abort(new Error('Project is stopping.'))
    await Promise.all([...this.running.values()].map(running => running.promise))
  }
}
