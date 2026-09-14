import { readFileSync } from 'node:fs'
import type { SessionPromptContext, SystemPromptProvider } from './builder.ts'
import { allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import { toolsGuideline } from './tools-guideline.ts'

// ── Constant fragments ───────────────────────────────────────────────

const SAFETY = readFileSync(new URL('./AGENTS.safety.md', import.meta.url), 'utf8')
const TOOLS = readFileSync(new URL('./AGENTS.tools.md', import.meta.url), 'utf8')

const CHAT_GROUP = `## Chats with Humans

You have access to your human's stuff. That doesn't mean you _share_ their stuff. In groups, you're a participant — not their voice, not their proxy.

### Know When to Speak

**Respond when:**

- Directly mentioned or asked a question
- You can add genuine value
- Something witty or helpful fits naturally

**Stay silent when:**

- Casual banter between humans
- Someone already answered
- Your response would just be "yeah" or "nice"
- The conversation flows fine without you

### Uploads

Any file, attachment, or image received from any channel is automatically saved to \`uploads/\` in this workspace. Check there when you need to access files shared by users.`

const CHAT_DIRECT = `## Chats with Humans

### Uploads

Any file, attachment, or image received from any channel is automatically saved to \`uploads/\` in this workspace. Check there when you need to access files shared by users.`

export function guidelineProvider(): SystemPromptProvider {
  return {
    name: 'guideline',
    getPromptSection(ctx) {
      const agentType = ctx.agent

      const sections = [agentType.prompt, SAFETY]

      const chat = ctx.isGroup ? CHAT_GROUP : CHAT_DIRECT
      sections.push(ctx.workdir && !ctx.workdir.capabilityId.startsWith('managed-session-v1:')
        ? chat.replace('`uploads/` in this workspace', 'the private session uploads directory shown in Workspace, not the project folder')
        : chat)

      sections.push(TOOLS)
      sections.push(toolsGuideline(ctx))
      sections.push(executionModeGuideline(ctx))
      return sections.join('\n\n')
    },
  }
}

export function executionModeGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const hasDelegationParent = !!ctx.parentSessionId
  const modes = isToolAllowed(ctx.agent, 'subagent')
    ? allowedSubagentModes(mode, hasDelegationParent) : []
  const decision = isToolAllowed(ctx.agent, 'yield')
    ? 'Use yield for blockers or decisions requiring input.'
    : 'Report blockers or missing input explicitly; do not invent an answer.'
  if (mode === 'call') {
    return `## Execution Contract: Call

You are executing a bounded function-like invocation, not starting another user conversation.
Use the inherited context to complete the caller's task. Do not repeat alignment interviews,
create an alignment document merely to satisfy an orchestration habit, or delegate just because
the caller's role usually coordinates agents. Keep the role's tool constraints and all safety rules.
The caller's execution is waiting for your final response as the original tool result.
This is a leaf call: you cannot yield, message other sessions, create subagents, or schedule
deferred coordination. These execution limits override coordination instructions in the role.
If required facts, authorization, or a consequential decision are missing, return a clear
blocked result immediately: what is missing, why it matters, what you already did, and any
external side effects. The caller decides or yields, then may issue a new call. Do not invent
an answer or retry side effects blindly. Ordinary execution failures must be reported as failures.
For a blocker, return raw JSON without fences or a preamble:
{"status":"blocked","reason":"What input or permission is missing and why","partialWork":"Actions already taken and their side effects"}
For a failed outcome, return raw JSON without fences or a preamble:
{"status":"failed","error":"What failed, including any partial work and side effects"}
Use nonempty reasons and errors. A successful call can return its final answer normally.
If exec is available, it runs foreground-only: timeout_ms must be 1 through 120000, never zero.
It terminates on timeout or cancellation instead of becoming a background task. Calls have a
120-second execution deadline; cleanup can require up to 10 additional seconds. Remote exec is
not supported within calls. Do not start detached work through another tool or script.
Intermediate work stays in this call's trace. Do not send a duplicate completion notification.
Context inheritance is a snapshot, not a shared live conversation; filesystem and other external
side effects are not rolled back.`
  }
  if (mode === 'task') {
    return `## Execution Contract: Task

Complete the supplied one-time task using your own task context. Make routine decisions yourself.
${decision} Your final response ends this task and is
reported automatically; do not send a duplicate completion message. This execution cannot accept
another task. ${modes.length
  ? 'You may create only blocking leaf calls. Finish them before reporting your final result.'
  : 'Delegation is unavailable for this role.'}
Do not promise follow-up in this task.`
  }
  return `## Execution Contract: Session

This is a reusable conversation with its own context. Complete the current request and retain
relevant context for later requests. A final response ends this turn, not the conversation.
When delegated, report the current task's result; do not send a duplicate completion message.
This is a ${hasDelegationParent ? 'sub-session' : 'root session'}. Allowed delegation modes:
${modes.join(', ') || 'none'}. Role tool restrictions still apply.
${decision}`
}
