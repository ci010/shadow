import type { Bus } from '../bus/bus.ts'
import { errMsg } from '../utils/truncate.ts'
import type { ExecutionContext } from './agent.ts'
import type { Tools } from '../tools/registry.ts'
import { parseMediaFromContent } from '../utils/media-parse.ts'
import type { EventService } from '../events/service.ts'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'
export type BackgroundTaskKind = 'tool' | 'subagent' | 'process'

export interface BackgroundTaskCallback {
  channel: string
  chatId: string
  contentPrefix?: string
  senderName?: string
  isGroup?: boolean
  /** Override the default event type ('background-task-complete') for the callback message.
   * Used as senderId prefix: `event:<eventType>`. */
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
}

interface BackgroundTaskRecord extends BackgroundTaskSummary {
  result?: string
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
  private tasks = new Map<string, BackgroundTaskRecord>()

  constructor(private bus: Bus, private events?: EventService) {
    // Auto-complete session-bound tasks when the session finishes.
    this.bus.on('message.outbound', (msg) => {
      if (!msg.done) return
      const sessionId = `${msg.channel}:${msg.chatId}`
      const task = this.findByTag('sessionId', sessionId)
      if (!task) return

      const summary = msg.content?.trim()
      if (!summary) {
        this.complete(task.id, '(session completed with no output)')
        return
      }
      const parsed = parseMediaFromContent(msg.content)
      this.complete(task.id, parsed.text)
    })
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
    const executionContext: ExecutionContext = {
      ...context,
      signal: new AbortController().signal,
    }
    return this.runPromiseTask(
      {
        kind: 'tool',
        title: options?.title ?? `Tool: ${name}`,
        sessionId: context.sessionId,
        callback: options?.callback,
      },
      tools.execute(name, args, executionContext),
    )
  }

  runPromiseTask(
    options: {
      kind: BackgroundTaskKind
      title: string
      sessionId?: string
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
    callback?: BackgroundTaskCallback
    observe?: () => Promise<string> | string
    onCancel?: () => void
    tags?: Record<string, string>
  }): {
    taskId: string
    complete: (value: string) => void
    fail: (reason?: unknown) => void
  } {
    const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const resolvers = Promise.withResolvers<string>()
    const record: BackgroundTaskRecord = {
      id: taskId,
      kind: options.kind,
      title: options.title,
      sessionId: options.sessionId,
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
      complete: (value: string) => this.completeTask(taskId, value),
      fail: (reason?: unknown) => this.failTask(taskId, reason),
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
      }))
  }

  async awaitTask(taskId: string, timeoutMs?: number): Promise<string> {
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`

    if (task.status !== 'running') {
      return this.formatTaskResult(task)
    }

    const timeoutSymbol = Symbol('timeout')
    const result = await Promise.race([
      task.promise,
      ...(timeoutMs !== undefined
        ? [
          new Promise<typeof timeoutSymbol>((resolve) =>
            setTimeout(() => resolve(timeoutSymbol), timeoutMs)
          ),
        ]
        : []),
    ])

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
    const task = this.tasks.get(taskId)
    if (!task) return `Error: no background task with id=${taskId}`

    if (!task.callback) {
      task.callback = { channel: '', chatId: '' }
    }
    task.callback.contentPrefix = continuation

    if (task.status !== 'running') {
      // Task already finished — re-fire the callback with the continuation
      this.publishCallback(task)
      return `Continuation set and callback re-fired for task ${taskId} (${task.status}).`
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
    this.publishCallback(task)
  }

  private failTask(taskId: string, reason?: unknown, skipCallback = false, cancel = false): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return

    if (cancel && task.onCancel) {
      try {
        task.onCancel()
      } catch { /* ignore */ }
    }

    const message = errMsg(reason)
    task.status = 'failed'
    task.completedAt = new Date().toISOString()
    task.error = message
    task.reject(reason)
    if (!skipCallback) this.publishCallback(task)
  }

  private publishCallback(task: BackgroundTaskRecord): void {
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

    // Emit outbound message so it shows up in the chat UI
    const icon = task.status === 'completed' ? '✅' : '❌'
    const shortTitle = task.title.length > 60 ? task.title.slice(0, 60) + '…' : task.title
    const displayContent = `${icon} [${task.kind}] ${shortTitle} — ${statusLine}`
    this.bus.emit('message.outbound', {
      event: 'response',
      channel: task.callback.channel,
      chatId: task.callback.chatId,
      done: false,
      content: displayContent,
    })

    if (this.events) {
      this.events.emit({
        type: eventType,
        source: 'background-task',
        content,
        targetSessionId: `${task.callback.channel}:${task.callback.chatId}`,
        senderName: task.callback.senderName ?? 'Background Task',
        isGroup: task.callback.isGroup,
        meta: {
          'task-id': task.id,
          kind: task.kind,
          title: task.title,
          status: statusLine,
        },
      })
      return
    }

    this.bus.emit('message.inbound', {
      channel: task.callback.channel,
      chatId: task.callback.chatId,
      senderId: `event:${eventType}`,
      senderName: task.callback.senderName ?? 'Background Task',
      messageId: crypto.randomUUID(),
      content,
      timestamp: new Date().toISOString(),
      isGroup: task.callback.isGroup,
      eventMeta: {
        'task-id': task.id,
        kind: task.kind,
        title: task.title,
        status: statusLine,
      },
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
    if (task.error) {
      lines.push('', task.error)
      return lines.join('\n')
    }
    if (task.result) lines.push('', task.result)
    return lines.join('\n')
  }
}
