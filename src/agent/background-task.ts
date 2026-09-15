import type { Bus } from '../bus/bus.ts'
import { errMsg } from '../utils/truncate.ts'
import type { ExecutionContext } from './agent.ts'
import type { Tools } from '../tools/registry.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import type { EventService } from '../events/service.ts'
import { sessionReplyAddress, type InputOrigin, type ReplyAddress } from '../sessions/input.ts'
import { getOrganizationScope, type OrganizationScope } from '../otel/scope.ts'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'
export type BackgroundTaskKind = 'tool' | 'subagent' | 'process'

export interface BackgroundTaskCallback {
  sessionId: string
  replyTo?: ReplyAddress
  contentPrefix?: string
  senderName?: string
  isGroup?: boolean
  /** Override the default event type ('background-task-complete'). */
  eventType?: string
}

export interface BackgroundTaskSummary {
  id: string
  kind: BackgroundTaskKind
  title: string
  sessionId?: string
  status: BackgroundTaskStatus
  createdAt: string
  completedAt?: string
  error?: string
  callbackError?: string
}

interface BackgroundTaskRecord extends BackgroundTaskSummary {
  result?: string
  origin?: InputOrigin
  callback?: BackgroundTaskCallback
  /** Returns live output for a running task (e.g. partial stdout, session history). */
  observe?: () => Promise<string> | string
  /** Invoked when the task is forcibly cancelled (kill tool). Used to terminate
   * an underlying long-lived process or abort its signal. */
  onCancel?: () => void
  /** Arbitrary key→value metadata for lookup (e.g. subagentSessionId). */
  tags?: Record<string, string>
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (reason?: unknown) => void
}

export class BackgroundTaskManager {
  get hasRunningTasks(): boolean {
    return [...this.tasks.values()].some(task => task.status === 'running') || this.callbacks.size > 0
  }
  private tasks = new Map<string, BackgroundTaskRecord>()
  private subscriptionId: string
  private stopped = false
  private callbacks = new Set<Promise<void>>()

  constructor(
    private bus: Bus,
    private events: EventService,
    private scope: OrganizationScope | undefined = getOrganizationScope(),
  ) {
    // Auto-complete session-bound tasks when the session finishes.
    this.subscriptionId = this.bus.on('session.turn.finished', (fact) => this.runOwned(() => {
      const task = this.findByTag('sessionId', fact.sessionId)
      if (!task) return
      const record = this.tasks.get(task.id)!
      record.origin = {
        sessionId: fact.sessionId,
        inputId: fact.inputId,
        source: { kind: 'session', sessionId: fact.sessionId },
      }
      if (fact.status !== 'completed') {
        this.fail(task.id, fact.error ?? `Session ${fact.status}`)
        return
      }
      const parsed = parseMediaFromContent(fact.content)
      this.complete(task.id, parsed.text.trim() || '(session completed with no output)')
    }))
  }

  /** Detach only this runtime's observer, cancel its work and drain accepted callbacks. */
  async stop(): Promise<void> {
    this.stopped = true
    this.bus.off(this.subscriptionId)
    for (const task of this.tasks.values()) {
      this.failTask(task.id, 'Organization runtime stopped', true, true)
    }
    await Promise.allSettled(this.callbacks)
  }

  private runOwned<T>(callback: () => T): T {
    return this.scope ? this.scope.run(callback) : callback()
  }

  /**
   * Called when a session stops unexpectedly (idle timeout, crash, explicit stop).
   * Fails any running background task bound to that session.
   */
  handleSessionStopped(sessionId: string): void {
    const task = this.findByTag('sessionId', sessionId)
    if (!task) return
    console.warn(`[background-task] Session ${sessionId} stopped, failing task ${task.id}`)
    this.fail(task.id, 'Session terminated unexpectedly')
  }

  runToolTask(
    tools: Tools,
    name: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
    options?: {
      title?: string
      callback?: BackgroundTaskCallback
    },
  ): string {
    if (this.stopped) throw new Error('BackgroundTaskManager is stopped')
    if (context.organizationId !== this.scope?.organizationId || tools !== context.tools) {
      throw new Error('Background tool task organization/context binding mismatch')
    }
    const controller = new AbortController()
    const executionContext: ExecutionContext = {
      ...context,
      signal: controller.signal,
    }
    return this.runPromiseTask(
      {
        kind: 'tool',
        title: options?.title ?? `Tool: ${name}`,
        sessionId: context.sessionId,
        inputId: context.messageId,
        callback: options?.callback,
        onCancel: () => controller.abort(new Error('Background task cancelled')),
      },
      this.runOwned(() => tools.execute(name, args, executionContext)),
    )
  }

  runPromiseTask(
    options: {
      kind: BackgroundTaskKind
      title: string
      sessionId?: string
      inputId?: string
      callback?: BackgroundTaskCallback
      observe?: () => Promise<string> | string
      onCancel?: () => void
    },
    promise: Promise<string>,
  ): string {
    const deferred = this.createDeferredTask(options)
    promise.then(deferred.complete).catch(deferred.fail)
    return deferred.taskId
  }

  createDeferredTask(options: {
    kind: BackgroundTaskKind
    title: string
    sessionId?: string
    inputId?: string
    callback?: BackgroundTaskCallback
    observe?: () => Promise<string> | string
    onCancel?: () => void
    tags?: Record<string, string>
  }): {
    taskId: string
    complete: (value: string) => void
    fail: (reason?: unknown) => void
  } {
    if (this.stopped) throw new Error('BackgroundTaskManager is stopped')
    const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const resolvers = Promise.withResolvers<string>()
    const record: BackgroundTaskRecord = {
      id: taskId,
      kind: options.kind,
      title: options.title,
      sessionId: options.sessionId,
      origin: options.sessionId
        ? {
          sessionId: options.sessionId,
          inputId: options.inputId ?? taskId,
          source: { kind: 'session', sessionId: options.sessionId },
        }
        : undefined,
      status: 'running',
      createdAt: new Date().toISOString(),
      callback: options.callback,
      observe: options.observe,
      onCancel: options.onCancel,
      tags: options.tags,
      promise: resolvers.promise,
      resolve: resolvers.resolve,
      reject: resolvers.reject,
    }
    record.promise.catch(() => {})
    this.tasks.set(taskId, record)

    return {
      taskId,
      complete: (value: string) => { if (!this.stopped) this.runOwned(() => this.completeTask(taskId, value)) },
      fail: (reason?: unknown) => { if (!this.stopped) this.runOwned(() => this.failTask(taskId, reason)) },
    }
  }

  listTasks(sessionId?: string): BackgroundTaskSummary[] {
    return Array.from(this.tasks.values())
      .filter((task) => !sessionId || task.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        title: task.title,
        sessionId: task.sessionId,
        status: task.status,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        error: task.error,
        callbackError: task.callbackError,
      }))
  }

  async awaitTask(taskId: string, timeoutMs?: number): Promise<string> {
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`

    if (task.status !== 'running') {
      return this.formatTaskResult(task)
    }

    const timeoutSymbol = Symbol('timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      task.promise,
      ...(timeoutMs !== undefined ? [
        new Promise<typeof timeoutSymbol>((resolve) => {
          timer = setTimeout(() => resolve(timeoutSymbol), timeoutMs)
        }),
      ] : []),
    ]).finally(() => { if (timer) clearTimeout(timer) })

    if (result === timeoutSymbol) {
      return [
        `Task ${task.id} is still running.`,
        `Kind: ${task.kind}`,
        `Title: ${task.title}`,
        `Started: ${task.createdAt}`,
      ].join('\n')
    }

    return this.formatTaskResult(this.tasks.get(taskId) ?? task)
  }

  /** Kill a running task. Marks it as failed and resolves its promise. */
  killTask(taskId: string): string {
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`
    if (task.status !== 'running') return `Task ${taskId} is already ${task.status}.`
    this.failTask(taskId, 'Killed by user.', true, true)
    return `Task ${taskId} killed.`
  }

  /**
   * Set a continuation string on a task. When the task's completion event fires
   * back to the session, it will carry this continuation text as a prefix.
   * If the task already completed, re-fires the callback with the continuation.
   */
  setContinuation(taskId: string, continuation: string): string {
    if (this.stopped) throw new Error('BackgroundTaskManager is stopped')
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`

    if (!task.callback) {
      if (!task.sessionId) return `Error: task ${taskId} has no callback session`
      task.callback = { sessionId: task.sessionId }
    }
    task.callback.contentPrefix = continuation

    if (task.status !== 'running') {
      // Task already finished — re-fire the callback with the continuation
      this.notifyCallback(task)
      return `Continuation set and callback scheduled for task ${taskId} (${task.status}).`
    }

    return `Continuation set for task ${taskId}. It will be included when the task completes.`
  }

  /** Get current output/status of a task without waiting. */
  async getTaskOutput(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`
    if (task.status === 'running' && task.observe) {
      const live = await task.observe()
      const lines = [
        `Task ID: ${task.id}`,
        `Kind: ${task.kind}`,
        `Title: ${task.title}`,
        `Status: running`,
        `Started: ${task.createdAt}`,
        '',
        live,
      ]
      return lines.join('\n')
    }
    return this.formatTaskResult(task)
  }

  /** Find a running task by a tag key/value pair. */
  findByTag(key: string, value: string): BackgroundTaskSummary | undefined {
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.tags?.[key] === value) {
        return {
          id: task.id,
          kind: task.kind,
          title: task.title,
          sessionId: task.sessionId,
          status: task.status,
          createdAt: task.createdAt,
        }
      }
    }
    return undefined
  }

  /** Complete a running task by ID. Returns false if not found or not running. */
  complete(taskId: string, result: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return false
    this.completeTask(taskId, result)
    return true
  }

  /** Fail a running task by ID. Returns false if not found or not running. */
  fail(taskId: string, reason?: unknown): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return false
    this.failTask(taskId, reason)
    return true
  }

  private completeTask(taskId: string, result: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return

    task.status = 'completed'
    task.completedAt = new Date().toISOString()
    task.result = result
    task.resolve(result)
    this.notifyCallback(task)
  }

  private failTask(taskId: string, reason?: unknown, skipCallback = false, cancel = false): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return

    if (cancel && task.onCancel) {
      try {
        task.onCancel()
      } catch (error) {
        console.error(`[background-task] Cancellation failed (${task.id}):`, error)
      }
    }

    const message = errMsg(reason)
    task.status = 'failed'
    task.completedAt = new Date().toISOString()
    task.error = message
    task.reject(reason)
    if (!skipCallback) this.notifyCallback(task)
  }

  private notifyCallback(task: BackgroundTaskRecord): void {
    if (this.stopped) return
    const pending = this.runOwned(() => this.publishCallback(task)).catch((error) => {
      task.callbackError = errMsg(error)
      console.error(`[background-task] Callback delivery failed (${task.id}, ${task.callback?.sessionId}):`, error)
    })
    this.callbacks.add(pending)
    void pending.then(() => this.callbacks.delete(pending))
  }

  private async publishCallback(task: BackgroundTaskRecord): Promise<void> {
    if (!task.callback) return

    const statusLine = task.status === 'completed'
      ? 'completed'
      : `failed: ${task.error ?? 'unknown error'}`
    const detail = task.status === 'completed'
      ? task.result?.trim() || '(no result)'
      : task.error ?? 'unknown error'
    const prefix = task.callback.contentPrefix?.trim()
    const content = prefix ? `${prefix}\n\n${detail}` : detail

    const eventType = task.callback.eventType ?? 'background-task-complete'

    await this.events.emit({
      type: eventType,
      source: 'background-task',
      content,
      targetSessionId: task.callback.sessionId,
      senderName: task.callback.senderName ?? 'Background Task',
      isGroup: task.callback.isGroup,
      origin: task.origin,
      meta: {
        'task-id': task.id,
        kind: task.kind,
        title: task.title,
        status: statusLine,
      },
    })
    task.callbackError = undefined
    if (this.stopped) return

    const reply = task.callback.replyTo ?? sessionReplyAddress(task.callback.sessionId)
    if (!reply) return
    const icon = task.status === 'completed' ? '✅' : '❌'
    const shortTitle = task.title.length > 60 ? task.title.slice(0, 60) + '…' : task.title
    const displayContent = `${icon} [${task.kind}] ${shortTitle} — ${statusLine}`
    this.bus.emit('message.outbound', {
      event: 'response',
      channel: reply.channel,
      chatId: reply.chatId,
      ...(reply.channelAddress ? { channelAddress: reply.channelAddress } : {}),
      done: false,
      content: displayContent,
    })

  }

  private formatTaskResult(task: BackgroundTaskRecord): string {
    const lines = [
      `Task ID: ${task.id}`,
      `Kind: ${task.kind}`,
      `Title: ${task.title}`,
      `Status: ${task.status}`,
      `Started: ${task.createdAt}`,
    ]
    if (task.completedAt) lines.push(`Completed: ${task.completedAt}`)
    if (task.sessionId) lines.push(`Session: ${task.sessionId}`)
    if (task.callbackError) lines.push(`Callback delivery failed: ${task.callbackError}`)
    if (task.error) {
      lines.push('', task.error)
      return lines.join('\n')
    }
    if (task.result) lines.push('', task.result)
    return lines.join('\n')
  }
}
