import type {
  ChatMessage,
  LLMProvider,
  LLMResponseUsage,
} from '../../providers/provider.ts'
import { contentText } from '../../providers/provider.ts'
import { workspacePath } from '../../utils/paths.ts'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { ReadTool } from '../../tools/read.ts'
import { SessionMemoryParser } from '../session-memory.ts'
import { Bus } from '../../bus/bus.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import { HandoffSession } from './session.ts'
import { type HandoffCapture, HandoffSummaryTool } from './tools.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { SessionStore } from '../session-store.ts'
import { getOrganizationScope, type OrganizationScope } from '../../organizations/scope.ts'
const handoffPromptTemplate = readFileSync(new URL('./HANDOFF.md', import.meta.url), 'utf8')

const MAX_HANDOFF_SUMMARY_LENGTH = 10_000
const HANDOFF_LLM_MAX_MESSAGES = 80
const HANDOFF_LOOP_MAX_TOKENS = 4000

export interface HandoffContext {
  summary: string
  currentObjective: string
  recentTranscript: string[]
}

interface HandoffOptions {
  sourceSessionKey: string
  sourceSessionId: string
  sourceMessageCount: number
  targetSessionId: string
  ts: string
  context: HandoffContext
}

export interface CompactResult {
  targetSessionId: string
  timestamp: string
  context: HandoffContext
  prompt: string
}

export interface HandoffConfig {
  /**
   * Whether to automatically trigger handoff when token usage ratio exceeds threshold. Default true.
   */
  autoHandoff?: boolean
  /**
   * Ratio of prompt tokens to max tokens that triggers auto handoff when exceeded. Value between 0.5 and 0.95, default 0.75.
   */
  handoffMinThreshold?: number
  handoffMaxThreshold?: number
  /**
   * Optional model override for handoff context synthesis. Falls back to agent's default model if not set.
   */
  model?: string
}

export class HandoffManager {
  private stopped = false
  private running = new Map<Promise<CompactResult>, AbortController>()
  handoffMinThreshold: number
  handoffMaxThreshold: number
  autoHandoff: boolean

  constructor(
    private provider: LLMProvider,
    private contextWindow: number,
    config: HandoffConfig,
    private workspace: string,
    private store: SessionStore,
    private scope: OrganizationScope | undefined = getOrganizationScope(),
  ) {
    this.autoHandoff = config.autoHandoff ?? true
    this.handoffMinThreshold = config.handoffMinThreshold ?? 0.75
    this.handoffMaxThreshold = config.handoffMaxThreshold ?? 0.95
  }

  async create(
    sessionId: string,
    sourceSessionId: string,
    targetSessionId: string,
    messages: ChatMessage[],
    model: string,
  ): Promise<CompactResult> {
    if (this.stopped) throw new Error('HandoffManager is stopped')
    const controller = new AbortController()
    const create = () => this.createWithinScope(sessionId, sourceSessionId, targetSessionId, messages, model, controller.signal)
    const pending = this.scope ? this.scope.run(create) : create()
    this.running.set(pending, controller)
    try {
      return await pending
    } finally {
      this.running.delete(pending)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.running.values()) controller.abort(new Error('Handoff runtime stopped'))
    await Promise.allSettled(this.running.keys())
  }

  private async createWithinScope(
    sessionId: string,
    sourceSessionId: string,
    targetSessionId: string,
    messages: ChatMessage[],
    model: string,
    signal: AbortSignal,
  ): Promise<CompactResult> {
    // Run the combined handoff+reflect loop
    const context = await this.runHandoffLoop(
      sessionId,
      messages,
      model,
      signal,
    )

    const snapshot: HandoffOptions = {
      sourceSessionKey: sessionId,
      sourceSessionId,
      sourceMessageCount: messages.length,
      targetSessionId,
      ts: new Date().toISOString(),
      context,
    }

    const summary = this.buildHandoffSummary(snapshot)

    return {
      targetSessionId,
      context,
      prompt: summary,
      timestamp: snapshot.ts,
    }
  }

  shouldHandoff(
    usage: LLMResponseUsage | undefined,
    inLoop: boolean,
    extraToken = 0,
  ): boolean {
    if (!this.autoHandoff) {
      console.debug('Auto handoff disabled by config')
      return false
    }
    if (!usage?.promptTokens) {
      console.debug('Auto handoff check: prompt token count unavailable')
      return false
    }
    if (this.contextWindow <= 0) {
      console.debug('Auto handoff check: invalid contextWindow')
      return false
    }
    return ((usage.promptTokens + extraToken) / this.contextWindow) >=
      (inLoop ? this.handoffMaxThreshold : this.handoffMinThreshold)
  }

  // ── Combined handoff + reflect loop ────────────────────────────────

  private async runHandoffLoop(
    sessionId: string,
    messages: ChatMessage[],
    model: string,
    signal: AbortSignal,
  ): Promise<HandoffContext> {
    const fallback = this.synthesizeContext(messages)
    const transcript = this.buildTranscript(messages)
    if (!transcript) return fallback

    const workspace = this.workspace

    const memoryPath = sessionMemoryRelativePath(sessionId)
    const absoluteMemoryPath = workspacePath(workspace, memoryPath)

    // Handoff no longer curates the full session-memory state — Modified Files,
    // events, keywords and conventions are maintained live elsewhere (see
    // MEM.md). It only produces the continuation Summary.
    const capture: HandoffCapture = {
      context: null,
      memoryState: SessionMemoryParser.parse(''),
      memoryUpdated: false,
    }

    // Build tools registry with handoff-specific tools only
    const tools = new Tools(workspace)
    tools.register(new HandoffSummaryTool(capture, fallback))
    tools.register(new ReadTool(workspace))
    const sessionTools = new SessionTools(tools, workspace)

    // Build initial messages
    const userContent = this.buildHandoffUserContent(transcript)
    const loopMessages: ChatMessage[] = [
      { role: 'system', content: handoffPromptTemplate },
      { role: 'user', content: userContent },
    ]

    const physicalId = sessionId + '-handoff'
    const executionContext: ExecutionContext = {
      ...(this.scope ? { organizationId: this.scope.organizationId } : {}),
      channel: 'handoff',
      senderId: 'handoff',
      chatId: sessionId,
      messageId: crypto.randomUUID(),
      sessionId: sessionId,
      physicalSessionId: physicalId,
      admin: true,
      tools: sessionTools,
      signal,
    }

    console.info(
      `[handoff] Starting combined handoff loop for session: ${sessionId}`,
    )

    await new HandoffSession(
      workspace,
      sessionId,
      { sessionId: sessionId, segmentIndex: 0, ...(this.scope ? { organizationId: this.scope.organizationId } : {}) },
      loopMessages,
      this.provider,
      sessionTools,
      new Bus(),
      this.store,
    ).run(executionContext, {
      model,
      temperature: 0,
      contextWindow: this.contextWindow,
      maxTokens: HANDOFF_LOOP_MAX_TOKENS,
    })
    signal.throwIfAborted()

    if (!capture.context) {
      console.warn(
        '[handoff] handoff_summary tool was not called, using local fallback',
      )
    }

    // The session-memory md IS the continuation Summary (MEM.md): current
    // focus + progress, produced only by compact.
    const md = renderContinuationSummary(capture.context ?? fallback)
    await mkdir(dirname(absoluteMemoryPath), { recursive: true })
    await writeFile(absoluteMemoryPath, md)
    console.info(`[handoff] Session summary written: ${absoluteMemoryPath}`)

    return capture.context ?? fallback
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildHandoffUserContent(transcript: string): string {
    return ['## Transcript', '', transcript].join('\n')
  }

  private synthesizeContext(messages: ChatMessage[]): HandoffContext {
    const nonSystem = messages.filter((m) => m.role !== 'system')

    const recentTranscript = nonSystem
      .slice(-24)
      .map((m) => {
        const content = contentText(m.content).trim()
        if (!content) return ''

        if (m.role === 'tool') {
          const label = m.name ? `tool:${m.name}` : 'tool'
          const firstLine = content.split(/\r?\n/).find((l) =>
            l.trim().length > 0
          ) ?? content
          return `[${label}] ${firstLine.slice(0, 80)}${
            content.length > 80 ? ' …' : ''
          }`
        }

        return `[${m.role}] ${content.slice(0, 160)}`
      })
      .filter((line) => line.length > 0)

    const currentObjective = [...nonSystem].reverse()
      .find((m) =>
        m.role === 'user' && contentText(m.content).trim().length > 0
      )
      ?.content
    const currentObjectiveText = (contentText(currentObjective).trim() ||
      'Continue the current task with existing constraints.')
      .slice(0, 240)

    return {
      summary: '',
      currentObjective: currentObjectiveText,
      recentTranscript,
    }
  }

  private buildTranscript(messages: ChatMessage[]): string {
    const recent = messages
      .filter((m) => m.role !== 'system')
      .slice(-HANDOFF_LLM_MAX_MESSAGES)
      .map((m) => {
        const content = contentText(m.content).trim()
        if (!content) return ''
        if (m.role === 'tool') {
          const label = m.name ? `tool:${m.name}` : 'tool'
          return `[${label}] ${content.slice(0, 600)}`
        }
        return `[${m.role}] ${content.slice(0, 600)}`
      })
      .filter((line) => line.length > 0)

    return recent.join('\n')
  }

  private buildHandoffSummary(snapshot: HandoffOptions): string {
    const lines = [
      '# Previous Conversation Summary',
      `- Previous session (${snapshot.sourceMessageCount} messages) can be accessed via: read("v:sessions/${snapshot.sourceSessionId}")`,
      `- Current Session: ${snapshot.targetSessionId}`,
      '',
      ...(snapshot.context.summary
        ? [
          '## Summary',
          this.normalizeEmbeddedMarkdown(snapshot.context.summary, 3),
          '',
        ]
        : []),
      ...(snapshot.context.recentTranscript.length > 0
        ? [
          '## Recent Transcript Excerpt',
          ...snapshot.context.recentTranscript.map((s) => `- ${s}`),
          '',
        ]
        : []),
      '## Current Objective',
      snapshot.context.currentObjective,
      '',
      '## Continuation Instruction',
      '- Persistent context (themes, files, decisions, progress) is in your Session Memory — refer to it.',
      '- Preserve conventions and objective unless newer user instruction overrides them.',
      '- Continue execution from the most recent unfinished work item.',
    ]

    const full = lines.join('\n')
    if (full.length <= MAX_HANDOFF_SUMMARY_LENGTH) return full
    return full.slice(0, MAX_HANDOFF_SUMMARY_LENGTH) +
      '\n...[handoff summary truncated]'
  }

  private normalizeEmbeddedMarkdown(
    content: string,
    minHeadingLevel: number,
  ): string {
    const normalized = content
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(#{1,6})(\s+.*)$/)
        if (!match) return line

        const [, hashes, rest] = match
        const headingLevel = hashes.length
        const nextLevel = Math.min(6, Math.max(headingLevel, minHeadingLevel))
        return `${'#'.repeat(nextLevel)}${rest}`
      })
      .join('\n')
      .trim()

    return normalized
  }
}

function sessionMemoryRelativePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `memory/sessions/${safe}.md`
}

/**
 * Render the continuation Summary written by compact — the session-memory md
 * (MEM.md: current focus + progress, nothing else).
 */
export function renderContinuationSummary(
  ctx: HandoffContext,
  at: string = new Date().toISOString(),
): string {
  return [
    '# Session Summary',
    `_Updated: ${at}_`,
    '',
    '## Current Focus',
    ctx.currentObjective || '(none)',
    '',
    '## Progress',
    ctx.summary || '(none)',
    '',
  ].join('\n')
}
