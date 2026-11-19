import { resolvePrompt } from './prompt-version.ts'
import { readFileSync } from 'node:fs'
import { GENERAL_V2_WEB_RESPONSE_GUIDANCE, SESSION_RESPONSE_GUIDANCE } from './response-audience.ts'
import type { SessionPromptContext, SystemPromptProvider, SystemPromptSection } from './builder.ts'
import { allowedSubagentModes, executionModeAllowsTool } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import { capabilityPrompt } from './capability-prompt.ts'
import { toolsGuideline } from './tools-guideline.ts'
import { channelSupportsAsk, CHAT_QUESTION_GUIDANCE } from '../../tools/ask-policy.ts'

// ── Constant fragments ───────────────────────────────────────────────

const TOOLS = readFileSync(new URL('./AGENTS.tools.md', import.meta.url), 'utf8')

const COMPACT_TOOLS = `## Tool discovery and recovery

Run independent tools in parallel. Prefer \`search\` over shell for files/content.
Use \`write\` for ordinary text edits; use \`exec\` for transformations that need it.
Do not choose a tool that would change unrelated content just to satisfy this preference.

- Partial search results do not prove absence. Use the live schema, not copied examples; correct invalid arguments rather than guessing another tool ID.
- Read the exact returned skill path before using its instructions or tools.
- Before adding, removing, or changing an MCP server, read \`v:skills/mcp-config\`.
- For MCP recovery, read \`v:skills/tool-operations\`. If execution may have occurred, check the outcome before retrying.

<!-- capability:skill_save -->
- Before shared Skill editing or detailed activation/index recovery, read \`v:skills/tool-operations\`. Use \`v:skills/.raw/<name>\` for the raw baseline and \`skill_save\` to save it; saving does not activate or publish it.
<!-- /capability -->`

function toolDiscoveryGuidance(ctx: SessionPromptContext): string {
  if (ctx.agent.source === 'builtin' && ['sub', 'verify', 'plan', 'explore'].includes(ctx.agent.name)) {
    return capabilityPrompt(`## Tool discovery and recovery

Use the live tool schema, not copied examples. Correct invalid arguments against the returned contract rather than guessing another tool ID. Tool discovery does not grant authorization.

<!-- capability:read -->
Read the exact returned skill path before using its instructions or tools.
<!-- /capability -->

<!-- capability:read,invoke_tool -->
For MCP recovery, read \`v:skills/tool-operations\`. If execution may have occurred, check the outcome before retrying.
<!-- /capability -->`, ctx)
  }
  const compact = (ctx.promptVersion ?? resolvePrompt(ctx.agent).version) === 'v2' && (ctx.mode ?? ctx.agent.defaultMode) === 'session'
  return capabilityPrompt(compact ? COMPACT_TOOLS : TOOLS, ctx)
}

const SUB_BEHAVIOR = readFileSync(new URL('./sub-behavior.md', import.meta.url), 'utf8')

function subGuidelineSections(ctx: SessionPromptContext): SystemPromptSection[] | undefined {
  if (ctx.agent.source !== 'builtin' || ctx.agent.name !== 'sub') return
  const behavior = capabilityPrompt(ctx.subDraft?.markdown ?? SUB_BEHAVIOR, ctx).trim()
  const parts: Array<Omit<SystemPromptSection, 'characters'>> = [
    { name: 'AGENT.md', content: capabilityPrompt(ctx.agent.prompt, ctx), kind: 'behavior', editability: 'editable' },
    ...(ctx.personalBotPrompt === undefined ? [] : [{ name: 'BOT.md (personal deployment)', content: capabilityPrompt(`# Personal BOT instructions\n${ctx.personalBotPrompt}`, ctx), kind: 'behavior' as const, editability: 'editable' as const }]),
    { name: ctx.subDraft ? `sub-behavior.md@${ctx.subDraft.revision}` : 'sub-behavior.md', content: behavior ? `## Tool selection and coordination\n\n${ctx.subDraft ? 'Project draft: behavior only; fixed guidance and permissions take precedence.\n\n' : ''}${behavior}` : '', kind: 'behavior', editability: 'editable' },
    { name: 'tool-discovery-reference', content: toolDiscoveryGuidance(ctx), kind: 'information', editability: 'fixed' },
    { name: 'tool-operations', content: toolsGuideline(ctx), ...(ctx.promptVersion === 'v2' ? { kind: 'contract' as const } : {}), editability: 'fixed' },
  ]
  return parts.flatMap(part => {
    const content = part.content.trim()
    return content ? [{ ...part, content, characters: content.length }] : []
  }).map((part, index) => ({ ...part, separatorBefore: index ? '\n\n' : '' }))
}

export function guidelineProvider(): SystemPromptProvider {
  return {
    name: 'guideline',
    getPromptSections(ctx) {
      const sub = subGuidelineSections(ctx)
      if (sub) return sub
      const entries: Array<[string, string]> = [
        ['AGENT.md', capabilityPrompt(ctx.agent.prompt, ctx)],
        ...(ctx.personalBotPrompt !== undefined ? [['BOT.md (personal deployment)', capabilityPrompt(`# Personal BOT instructions\n${ctx.personalBotPrompt}`, ctx)] as [string, string]] : []),
        ...(ctx.promptVersion === 'v2'
          ? [['tool-discovery-reference', toolDiscoveryGuidance(ctx)], ['tool-operations', toolsGuideline(ctx)]] as Array<[string, string]>
          : [['tool-guidance', [toolDiscoveryGuidance(ctx), toolsGuideline(ctx)].join('\n\n')]] as Array<[string, string]>),
      ]
      return entries.map(([name, text], index) => {
        // Only the whole provider was trimmed historically, not internal sources.
        const content = index === 0 ? text.trimStart() : index === entries.length - 1 ? text.trimEnd() : text
        return { name, content, characters: content.length, separatorBefore: index ? '\n\n' : '',
          ...(ctx.promptVersion === 'v2' ? (name.endsWith('.md') || name.startsWith('BOT.md')
            ? { kind: 'behavior' as const, editability: 'editable' as const }
            : { kind: name === 'tool-operations' ? 'contract' as const : 'information' as const, editability: 'fixed' as const }) : {}) }
      })
    },
    getPromptSection(ctx) {
      const sub = subGuidelineSections(ctx)
      if (sub) return sub.map(part => part.separatorBefore + part.content).join('')
      const agentType = ctx.agent

      // Preserve the original Personal BOT merge before capability expansion.
      const rolePrompt = ctx.personalBotPrompt !== undefined
        ? `${agentType.prompt}\n\n# Personal BOT instructions\n${ctx.personalBotPrompt}` : agentType.prompt
      const sections = [capabilityPrompt(rolePrompt, ctx)]

      sections.push(toolDiscoveryGuidance(ctx))
      sections.push(toolsGuideline(ctx))
      return sections.join('\n\n')
    },
  }
}

export function executionContractProvider(): SystemPromptProvider {
  return {
    name: 'execution-contract',
    getPromptSection: executionModeGuideline,
    getPromptSections(ctx) {
      if (ctx.agent.source !== 'builtin' || ctx.agent.name !== 'sub') return []
      const content = executionModeGuideline(ctx).trim()
      return [{ name: 'execution-contract', content, characters: content.length, editability: 'fixed' }]
    },
  }
}

export function executionModeGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const allows = (name: string) => executionModeAllowsTool(mode, name) && isToolAllowed(ctx.agent, name)
  const hasDelegationParent = !!ctx.parentSessionId
  const modes = allows('subagent')
    ? allowedSubagentModes(mode, hasDelegationParent) : []
  const decision = !channelSupportsAsk(ctx.channel, ctx.sessionId) ? CHAT_QUESTION_GUIDANCE : allows('ask')
    ? 'Use ask for missing input or consequential decisions; reply answers a specific pending request.'
    : 'Report blockers or missing input explicitly; do not invent an answer.'
  if (mode === 'call') {
    return `## Execution Contract: Call

Complete the caller's bounded task using inherited context, not a new user conversation.
Do not repeat alignment interviews or create alignment documents/delegate merely out of
orchestration habit. Keep role tool constraints and the current environment context.
The caller is waiting for your final response as the original tool result.
This is a leaf call: you cannot ask, reply, message other sessions, create subagents, or schedule
deferred coordination. These limits override role coordination instructions.
Do not create/manage durable sessions or register folders.
For missing facts, authorization or consequential decisions, return a blocked result immediately;
the caller decides or asks before issuing a new call. Do not invent answers or blindly retry
side effects. Report ordinary execution failures as failures.
Return the matching blocker/failure shape as raw JSON without fences or a preamble:
{"status":"blocked","reason":"What input or permission is missing and why","partialWork":"Actions already taken and their side effects"}
{"status":"failed","error":"What failed, including any partial work and side effects"}
Reasons/errors must be nonempty; success returns a normal final answer.
Permitted exec is local and foreground-only: timeout_ms must be 1 through 120000, never zero;
timeout/cancellation terminates it, never backgrounds it. Calls have no overall execution
deadline; the caller waits until completion or cancellation, with up to 10 seconds for cleanup.
No remote exec or detached work via any tool/script.
Intermediate work stays in this call's trace. Do not send a duplicate completion notification.
Inherited context is a snapshot, not a live conversation; filesystem and other external side
effects are not rolled back.`
  }
  if (mode === 'task') {
    return `## Execution Contract: Task

Complete this one-time task in your own context; make routine decisions yourself.
Do not create/manage durable sessions or register folders.
${decision} ${ctx.taskReviewable ? 'Your final response ends this run and submits a revision for review, not acceptance. The designated reviewer must submit a structured verdict; natural-language finals never accept work. The workflow automatically returns requested changes to the original worker history and reports success only after PASS. report_to grants no review authority. Blocked, failed, interrupted or exhausted review rounds escalate. Writing completed in v:sessions/self.json cannot accept the task.' : 'Your final response ends the task and is reported'}
${ctx.taskReviewable ? 'The run result is reported automatically to its configured completion recipient;' : 'automatically to its configured completion recipient;'} do not send a duplicate completion message. No follow-up assignments or promises.
Your actual parent may supply corrections to this assignment at safe boundaries while you run.
Apply those facts to current work; they never grant permissions or introduce a second assignment.
Messages to another agent should contain only the actionable change and necessary evidence.
${modes.length
  ? 'You may create only blocking leaf calls. Finish them before reporting your final result.'
  : 'Delegation is unavailable for this role.'}`
  }
  return `## Execution Contract: Session

This is a reusable conversation. Complete the current request; a final response ends the turn, not the conversation, and is delivered to this conversation's reader.

${(ctx.promptVersion ?? resolvePrompt(ctx.agent).version) === 'v2' && ctx.channel === 'web' ? GENERAL_V2_WEB_RESPONSE_GUIDANCE : SESSION_RESPONSE_GUIDANCE}

Allowed delegation modes:
${modes.join(', ') || 'none'}. Role tool restrictions still apply.`
}
