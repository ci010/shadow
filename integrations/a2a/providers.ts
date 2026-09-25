import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Options as ClaudeOptions } from '@anthropic-ai/claude-agent-sdk'
import type { CodexOptions, Thread, ThreadOptions } from '@openai/codex-sdk'
import type { CopilotClientOptions, SessionConfig, ResumeSessionConfig } from '@github/copilot-sdk'
import type { A2aRunner, A2aInteraction } from '../../src/a2a/service.ts'
import { CodingContexts } from './contexts.ts'
import { bridgeEnvironment, type CodingBridgeConfig } from './config.ts'

interface ClaudeMessage {
  type: string; session_id?: string; subtype?: string; is_error?: boolean; result?: string; permission_denials?: unknown[]
}
interface ClaudeQuery extends AsyncIterable<ClaudeMessage> { close(): void }
type CodexThread = Pick<Thread, 'id' | 'runStreamed'>
interface CopilotSession {
  sessionId: string
  sendAndWait(prompt: string, timeout: number): Promise<{ data: { content: string } } | undefined>
  abort(): Promise<void>
  disconnect(): Promise<void>
}
export interface CodingSdks {
  claude(options: { prompt: string; options: ClaudeOptions }): ClaudeQuery
  codex(options: CodexOptions): {
    startThread(options: ThreadOptions): CodexThread
    resumeThread(id: string, options: ThreadOptions): CodexThread
  }
  copilot(options: CopilotClientOptions): {
    createSession(options: SessionConfig): Promise<CopilotSession>
    resumeSession(id: string, options: ResumeSessionConfig): Promise<CopilotSession>
    stop(): Promise<Error[]>
  }
}

export const officialCodingSdks = {
  async load(type: CodingBridgeConfig['backend']['type']): Promise<Partial<CodingSdks>> {
    if (type === 'claude') return { claude: (await import('@anthropic-ai/claude-agent-sdk')).query }
    if (type === 'codex') {
      const { Codex } = await import('@openai/codex-sdk')
      return { codex: options => new Codex(options) }
    }
    const { CopilotClient } = await import('@github/copilot-sdk')
    return { copilot: options => new CopilotClient(options) }
  },
}

const questionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1).max(8192),
    options: z.array(z.object({ label: z.string().min(1).max(1024) }).passthrough()).max(16).optional(),
  }).passthrough()).min(1).max(4),
}).passthrough()

async function answerClaude(input: Record<string, unknown>, interaction: A2aInteraction) {
  const { questions } = questionsSchema.parse(input)
  const answers: Record<string, string> = {}
  for (const question of questions) {
    answers[question.question] = await interaction.ask([
      question.question, ...(question.options?.map(option => `- ${option.label}`) ?? []),
    ].join('\n'))
  }
  return { ...input, answers }
}

export function codingRunner(config: CodingBridgeConfig, sdks: Partial<CodingSdks>): A2aRunner {
  const contexts = new CodingContexts(config)
  const home = join(config.stateDirectory, config.backend.type)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const environment = bridgeEnvironment(config.environment)
  return {
    async run(record, message, signal, interaction) {
      if (signal.aborted) return { status: 'cancelled', content: '' }
      const prompt = message.parts.map(part => part.content?.value).join('\n')
      const resume = contexts.get(record)
      try {
        if (config.backend.type === 'claude') {
          if (!sdks.claude) throw new Error('Claude SDK is unavailable.')
          const controller = new AbortController()
          const abort = () => controller.abort(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          const tools = config.backend.tools.filter(name => name !== 'AskUserQuestion')
          let query: ClaudeQuery | undefined
          try {
            query = sdks.claude({
              prompt,
              options: {
                cwd: config.cwd, model: config.model, resume, abortController: controller,
                env: { ...environment, CLAUDE_CONFIG_DIR: home },
                settingSources: [], mcpServers: {}, strictMcpConfig: true,
                tools: [...tools, 'AskUserQuestion'], allowedTools: tools,
                permissionMode: 'default',
                canUseTool: async (name, input) => name === 'AskUserQuestion'
                  ? { behavior: 'allow', updatedInput: await answerClaude(input, interaction) }
                  : { behavior: 'deny', message: 'Not authorized by the coding bridge operator.', interrupt: true },
              },
            })
            let content: string | undefined
            for await (const event of query) {
              if (event.session_id) contexts.set(record, event.session_id)
              if (event.type !== 'result') continue
              if (event.subtype !== 'success' || event.is_error !== false || event.permission_denials?.length) {
                throw new Error('Claude task failed or required permissions not granted by the operator.')
              }
              if (typeof event.result !== 'string') throw new Error('Claude returned no final text.')
              content = event.result
            }
            if (content === undefined) throw new Error('Claude stopped without a final result.')
            return { status: 'completed', content }
          } finally {
            query?.close()
            signal.removeEventListener('abort', abort)
          }
        }
        if (config.backend.type === 'codex') {
          if (!sdks.codex) throw new Error('Codex SDK is unavailable.')
          const client = sdks.codex({ env: { ...environment, CODEX_HOME: home } })
          const options: ThreadOptions = {
            workingDirectory: config.cwd, model: config.model, sandboxMode: config.backend.sandbox,
            approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
          }
          const thread = resume ? client.resumeThread(resume, options) : client.startThread(options)
          const { events } = await thread.runStreamed(prompt, { signal })
          let content: string | undefined
          let completed = false
          for await (const event of events) {
            if (event.type === 'thread.started') contexts.set(record, event.thread_id)
            if (event.type === 'item.completed' && event.item.type === 'agent_message') content = event.item.text
            if (event.type === 'turn.completed') completed = true
            if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex reported an execution failure.')
          }
          if (!completed || content === undefined) throw new Error('Codex stopped without a completed turn and final text.')
          return { status: 'completed', content }
        }
        if (!sdks.copilot) throw new Error('Copilot SDK is unavailable.')
        const client = sdks.copilot({
          mode: 'empty', workingDirectory: config.cwd, baseDirectory: home, env: environment,
          gitHubToken: environment.COPILOT_GITHUB_TOKEN ?? environment.GH_TOKEN ?? environment.GITHUB_TOKEN,
          useLoggedInUser: false, logLevel: 'error',
        })
        let session: CopilotSession | undefined
        let aborting: Promise<void> | undefined
        let abortError: unknown
        let permissionDenied = false
        const canceled = Promise.withResolvers<never>()
        const abort = () => {
          canceled.reject(signal.reason)
          if (session) {
            aborting ??= session.abort()
            void aborting.catch(error => { abortError = error })
          }
        }
        try {
          const options: SessionConfig = {
            model: config.model, workingDirectory: config.cwd,
            availableTools: [...config.backend.tools, 'ask_user'], mcpServers: {}, customAgents: [],
            onPermissionRequest: () => {
              permissionDenied = true
              return { kind: 'reject', feedback: 'Permission requires the coding bridge operator; remote text is not approval.' }
            },
            onUserInputRequest: async request => {
              const answer = await interaction.ask([request.question, ...(request.choices?.map(choice => `- ${choice}`) ?? [])].join('\n'))
              const wasFreeform = !request.choices?.includes(answer)
              if (request.allowFreeform === false && wasFreeform) throw new Error('The response must match one of the requested choices.')
              return { answer, wasFreeform }
            },
          }
          session = resume ? await client.resumeSession(resume, options) : await client.createSession(options)
          contexts.set(record, session.sessionId)
          signal.throwIfAborted()
          signal.addEventListener('abort', abort, { once: true })
          const result = await Promise.race([session.sendAndWait(prompt, config.server.timeoutMs + 1000), canceled.promise])
          if (permissionDenied) throw new Error('Copilot required permissions not granted by the bridge operator.')
          if (!result) throw new Error('Copilot stopped without a final response.')
          return { status: 'completed', content: result.data.content }
        } finally {
          signal.removeEventListener('abort', abort)
          try {
            if (aborting) await aborting
            if (abortError) throw abortError
            await session?.disconnect()
          } finally {
            const errors = await client.stop()
            if (errors.length) throw new AggregateError(errors, 'Copilot runtime did not stop cleanly.')
          }
        }
      } catch (error) {
        if (signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError')) {
          return { status: 'cancelled', content: '' }
        }
        throw error
      }
    },
  }
}
