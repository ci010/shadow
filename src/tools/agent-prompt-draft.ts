import { randomUUID } from 'node:crypto'
import { readAgentPromptDraft, saveAgentPromptDraft, type SubOverrideStore } from '../agent/context/sub-override.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import { isRetiredBuiltinGeneral } from '../agent/types/types.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import { assertPromptDraftOwner } from './sub-override-save.ts'
import type { Tool } from './tool.ts'

export function agentPromptDraftTools(
  subOverrides: SubOverrideStore,
  projectId: string,
  agentTypes: Pick<AgentTypesManager, 'resolve'>,
  sessions: Pick<SessionManager, 'alignment' | 'buildSession' | 'getSessionState' | 'getContext'>,
  authorized: (context: ExecutionContext) => boolean,
): Tool[] {
  const draftRole = (name: unknown, forPreview = false) => {
    if (typeof name !== 'string' || name.startsWith('a2a:')) throw new Error('Specify an exact local agent definition; remote A2A prompt drafts are unsupported.')
    const role = agentTypes.resolve(name)
    if (!role || role.runtimeOrigin) throw new Error('Unknown local definition or publisher-managed role.')
    if (!forPreview && isRetiredBuiltinGeneral(role)) throw new Error('This General definition is retired for new runs; use "general".')
    return role
  }
  const save: Tool = {
    name: 'agent_prompt_draft_save', readonly: false,
    description: 'Save an immutable replacement for the complete AGENT.md body of an exact local agent definition, including pinned shared behavior fragments. Does not enable the draft. Direct Project owner Web turn only.',
    parameters: { type: 'object', additionalProperties: false, required: ['agent_type', 'markdown'], properties: {
      agent_type: { type: 'string' }, markdown: { type: 'string', description: 'Behavior Markdown, at most 16 KiB.' },
    } },
    async execute(args, context) {
      assertPromptDraftOwner(context, projectId, authorized)
      if (Object.keys(args).some(key => key !== 'agent_type' && key !== 'markdown') || typeof args.markdown !== 'string') throw new TypeError('Expected agent_type and markdown.')
      const role = draftRole(args.agent_type)
      const revision = await saveAgentPromptDraft(subOverrides, role, args.markdown)
      return JSON.stringify({ agentType: role.name, revision, enabled: false })
    },
  }
  const create: Tool = {
    name: 'agent_prompt_session_create', readonly: false,
    description: 'Create a fresh idle Web session pinned to an exact local role draft. This is a real session, not a sandbox; creation itself does not run inference. Direct Project owner Web turn only.',
    parameters: { type: 'object', additionalProperties: false, required: ['agent_type', 'prompt_revision'], properties: {
      agent_type: { type: 'string' }, prompt_revision: { type: 'string' },
    } },
    async execute(args, context) {
      assertPromptDraftOwner(context, projectId, authorized)
      if (Object.keys(args).some(key => key !== 'agent_type' && key !== 'prompt_revision') || typeof args.prompt_revision !== 'string') throw new TypeError('Expected agent_type and prompt_revision.')
      const role = draftRole(args.agent_type)
      if (role.root && !(role.source === 'builtin' && role.name === 'general')) {
        throw new Error('Host-only roles cannot start independent Web sessions. Use an existing permitted execution path.')
      }
      if (sessions.alignment?.required(context.sessionId)) throw new Error('Cannot create an unmanaged draft session from a Work-bound session.')
      const promptDraft = await readAgentPromptDraft(subOverrides, role, args.prompt_revision)
      context.signal.throwIfAborted()
      const chatId = `chat-${randomUUID()}`
      const sessionId = `web:${chatId}`
      await sessions.buildSession(sessionId, undefined, { mode: 'session', agentType: role.name, promptDraft, name: `${role.name.slice(0, 70)} draft ${promptDraft.revision.slice(0, 12)}` })
      return JSON.stringify({ sessionId, chatId, agentType: role.name, promptRevision: promptDraft.revision,
        promptVersion: sessions.getSessionState(sessionId)?.promptVersion, status: 'idle', inferenceStarted: false })
    },
  }
  const preview: Tool = {
    name: 'agent_prompt_draft_preview', readonly: true,
    description: 'Compose a synthetic owner-Web role prompt using an exact saved draft. No session is created, no model runs, and no tools are invoked.',
    parameters: { type: 'object', additionalProperties: false, required: ['agent_type', 'prompt_revision'], properties: {
      agent_type: { type: 'string' }, prompt_revision: { type: 'string' },
    } },
    async execute(args, context) {
      assertPromptDraftOwner(context, projectId, authorized)
      if (Object.keys(args).some(key => key !== 'agent_type' && key !== 'prompt_revision') || typeof args.prompt_revision !== 'string') throw new TypeError('Expected agent_type and prompt_revision.')
      const role = draftRole(args.agent_type, true)
      const draft = await readAgentPromptDraft(subOverrides, role, args.prompt_revision)
      context.signal.throwIfAborted()
      const result = await sessions.getContext({ agentType: role.name, channel: 'web', rolePreview: 'owner-web', previewDraft: { draft, mode: role.defaultMode } })
      return JSON.stringify({ ...result, inferenceStarted: false, sessionCreated: false })
    },
  }
  return [save, preview, create]
}
