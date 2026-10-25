import { readFileSync } from 'node:fs'
import { SESSION_RESPONSE_GUIDANCE } from './response-audience.ts'
import type { SessionPromptContext, SystemPromptProvider } from './builder.ts'
import { allowedSubagentModes, executionModeAllowsTool } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import { capabilityPrompt } from './capability-prompt.ts'
import { toolsGuideline } from './tools-guideline.ts'
import { channelSupportsAsk, CHAT_QUESTION_GUIDANCE } from '../../tools/ask-policy.ts'

// ── Constant fragments ───────────────────────────────────────────────

const TOOLS = readFileSync(new URL('./AGENTS.tools.md', import.meta.url), 'utf8')

export function guidelineProvider(): SystemPromptProvider {
  return {
    name: 'guideline',
    getPromptSection(ctx) {
      const agentType = ctx.agent

      const sections = [capabilityPrompt(agentType.prompt, ctx)]

      sections.push(capabilityPrompt(TOOLS, ctx))
      sections.push(toolsGuideline(ctx))
      return sections.join('\n\n')
    },
  }
}

export function executionContractProvider(): SystemPromptProvider {
  return { name: 'execution-contract', getPromptSection: executionModeGuideline }
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
timeout/cancellation terminates it, never backgrounds it. Calls have a
120-second execution deadline plus up to 10 seconds for cleanup. No remote exec or detached
work via any tool/script.
Intermediate work stays in this call's trace. Do not send a duplicate completion notification.
Inherited context is a snapshot, not a live conversation; filesystem and other external side
effects are not rolled back.`
  }
  if (mode === 'task') {
    return `## Execution Contract: Task

Complete this one-time task in your own context; make routine decisions yourself.
Do not create/manage durable sessions or register folders.
${decision} ${ctx.taskReviewable ? 'Your final response ends this run and submits a revision for review, not acceptance. The designated reviewer must submit a structured verdict; natural-language finals never accept work. The workflow automatically returns requested changes to the original worker history and reports success only after PASS. report_to grants no review authority. Blocked, failed, interrupted or exhausted review rounds escalate. Writing completed in v:session/self.json cannot accept the task.' : 'Your final response ends the task and is reported'}
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

${SESSION_RESPONSE_GUIDANCE}

Allowed delegation modes:
${modes.join(', ') || 'none'}. Role tool restrictions still apply.`
}
