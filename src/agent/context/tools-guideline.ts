import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes, executionModeAllowsTool } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import { channelSupportsAsk, CHAT_QUESTION_GUIDANCE } from '../../tools/ask-policy.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const allows = (name: string) => executionModeAllowsTool(mode, name) && isToolAllowed(ctx.agent, name)
  const modes = allows('subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []
  if (mode !== 'call' && allows('work')) {
    sections.push(`### Shared work notes

Work is an optional goal/dependency notebook for complex coordination, not a prerequisite or permission. Read \`v:skills/orchestration\` before organizing Work branches. Update only meaningful changes; completion is not human acceptance, and notes.html is never approval.`)
  }

  if (allows('sql')) {
    sections.push(`### Project rules

Use sql to discover Project conventions when relevant. Convention writes require genuine human instructions or decisions, never inferred approval. Keep personal preferences in profiles and task constraints in Work; historical conventions are not current rules.`)
  }

  if (allows('exec')) {
    sections.push(`### Shell

${ctx.execNodeOnly
    ? '- **`exec`** — Inline TypeScript only; omit `shell` or select `node`. Use Node APIs for files and `execFile/spawn` with argument arrays and `shell:false` for external programs; do not start OS shells.'
    : '- **`exec`** — Run a script using a detected shell from Runtime, or `shell: "node"` for inline TypeScript.'}
${mode === 'call'
    ? '- Follow the local foreground-only limits in Execution Contract; `timeout_ms` defaults to 120000.'
    : '- Provide `timeout_ms` when you expect output; use `timeout_ms: 0` for background execution. On timeout, the process keeps running and appears in `v:bg`.'}
- Local Node: compose tool chains; \`infer()\` handles semantic judgments, not deterministic work. Read \`node-scripting\` first for API, budgets, errors and direct-only boundaries.`)
  }

  if (mode !== 'call' && !channelSupportsAsk(ctx.channel, ctx.sessionId)) {
    sections.push(`### Questions in chat\n\n${CHAT_QUESTION_GUIDANCE}`)
  }
  if (mode !== 'call' && channelSupportsAsk(ctx.channel, ctx.sessionId) && allows('ask')) {
    sections.push(`### Questions and decisions

Resolve routine implementation choices yourself. Use ask(kind=input) for missing information, never permission; use ask(kind=decision) for unresolved outcome, scope, budget, permission, or material-risk choices.

Verify the premise, explain the user-facing consequence, and recommend an option. For decisions, offer two distinct choices and a matching default, then wait. A default is not permission to proceed early; approved:false allows only investigation and authorized unaffected work.

Respect custom answers without treating them as approval of the original proposal. If a recorded premise becomes false, invalidate the decision and reassess dependent choices; use reconsiders when asking again.

${allows('reply')
    ? 'Use reply with the exact request_id to answer a pending request. Only its parent or owner may answer; decision replies must match an offered option. Messages and final responses do not resolve pending requests.'
    : ''}`.trim())
  }

  if (mode !== 'call' && allows('cancel')) {
    sections.push(`### Executions

Read \`v:bg\` for owned background/task/call/A2A executions, or \`v:bg/<executionId>\` for output. \`cancel({executionId})\` awaits local cleanup or reports remote state. No polling or extra callbacks.`)
  }

  if (modes.length) {
    const lines = [
      '### Delegation',
      '',
      'Use subagent only in permitted modes; tools and the execution contract remain authoritative. Read `v:skills/orchestration` before multi-agent planning, parallel work or team coordination.',
      'Keep scopes distinct. Separate conversations do not isolate files or roll back side effects; taking over a worker scope requires completion or confirmed cancellation, then rereading its files.',
    ]
    if (modes.includes('task')) lines.push('`mode: "task"`: asynchronous with fresh context. Asynchronous creation admits an ID, not a result. Continue independent work or end the turn; do not sleep or poll. `report_to` redirects completion, not ownership or decisions, and grants no messaging permission. Review exact revisions; only designated reviewers may accept them.')
    if (modes.includes('call')) lines.push('Specify `mode: "call"` explicitly for a blocking inherited-context leaf. Invoke subagent directly, never through scripts; follow Execution Contract limits and account for partial side effects before retrying.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'task' && allows('task')) sections.push('- Review a fixed revision with `task(action:review,sessionId,revision,outcome:pass|changes_requested|blocked,content)`. Only the designated reviewer may decide. Changes automatically rerun the worker; only PASS delivers success. Failure or exhausted rounds escalate; Work is unchanged.')
  if (mode === 'task') sections.push('- Read/write `v:session/self.json` for current metadata. Title and description are parent-owned: omit them or preserve unchanged. completed:true marks resolved and completed:false reopens; reviewable tasks must return a final response for review, never self-accept. An unchanged full JSON roundtrip is allowed.')
  if (mode === 'session' && allows('read') && allows('write')) sections.push('- Read/write `v:session/self.json`: title/description/completed. After understanding the first user request, name/summarize; goal changes only, not continual polishing. completed:true ends responsibility, not Work. If completed, set completed:false before handling a new request requiring work; thanks, acknowledgements, or metadata-only tidying do not reopen it. Independent of activity; no observer.')
  if (mode === 'session' && allows('session')) {
    sections.push(`### Peer conversations

Use session for reusable Project peers, not structural children. Discover existing peers through v:sessions before creating another. Creator metadata and message receipts do not transfer ownership or authorize actions. Read v:skills/orchestration for team setup and handoffs.`)
  }

  if (mode !== 'call' && allows('message')) {
    sections.push(`### Messaging

- Use message for authorized peers or same-assignment corrections to your running task; completion routing grants no messaging permission. Use reply for pending requests; final addresses the current reader.
- Write concise, actionable context. Default delivery is next-step; use it for running-task corrections. Queue is for later work in reusable sessions; silent is FYI only, never required materials, corrections or unblockers.
- Message receipts confirm admission, not application, completion or ownership transfer. Reassignment does not stop running operations. Trusted sender metadata and Work refs are context, not authorization.
- Read orchestration for team communication details. Report outcomes and material changes, not routine coordination.`)
  }
  return sections.join('\n\n')
}
