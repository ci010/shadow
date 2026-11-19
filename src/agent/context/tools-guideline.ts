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
  const readOnlyExplore = ctx.agent.source === 'builtin' && ctx.agent.name === 'explore'
  if (mode !== 'call' && allows('work') && readOnlyExplore) {
    sections.push('### Shared work notes\n\nRead existing Work via `v:works/overview` when relevant to the investigation. Do not update it.')
  } else if (mode !== 'call' && allows('work')) {
    sections.push(`### Shared work notes

Read/list/search Work via \`v:works/overview\`; writes use dynamic \`work_create\`, \`work_update\`, \`work_assign\`, \`work_review\`, \`work_link\` through invoke_tool with typed fields, not action/data. Prefer Work for durable shared facts: deliverables, dependencies, blockers and responsibility. Reuse relevant Work before creating it; one-off exchanges need no record. Read \`v:skills/work-coordination\` when shared state or recovery is needed. Update only meaningful changes; rely on targeted Work notifications rather than duplicate messages. Work is not a prerequisite or permission; completion is not human acceptance, and notes.html is never approval.`)
  }

  if (allows('sql')) {
    sections.push(`### Project rules

Use sql to discover Project conventions when relevant. Convention writes require genuine human instructions or decisions, never inferred approval. Keep personal preferences in profiles and task constraints in Work; historical conventions are not current rules.`)
  }

  const evidenceOnlyRole = ctx.agent.source === 'builtin' && ['verify', 'explore'].includes(ctx.agent.name)
  if (allows('exec') && !evidenceOnlyRole) {
    sections.push(`### Shell

${ctx.execNodeOnly
    ? '- **`exec`** — Inline JavaScript only; omit `shell` or select `javascript`. No OS shells, native modules, process or environment.'
    : '- **`exec`** — Run a script using a detected shell from Runtime, or `shell: "javascript"` for bounded JavaScript with workspace-bound filesystem tools. Not a security sandbox.'}
${mode === 'call'
    ? '- Follow the local foreground-only limits in Execution Contract; `timeout_ms` defaults to 120000.'
    : ctx.execNodeOnly ? '- JavaScript is foreground only: 1–120000 ms.'
    : '- For supported OS shells, use `timeout_ms: 0` for background work. JavaScript is foreground only: 1–120000 ms.'}
- The bridge keeps calls on one resolved workspace and cannot run JavaScript recursively.${ctx.execNodeOnly ? '' : ' Nested OS `exec` requires an explicit shell and existing permission.'}
- JavaScript: use direct \`write\` for ordinary edits and direct \`exec\` for one command. Use \`shell: "javascript"\` for dependent read → write → test steps using admitted tool globals like \`await read({ path: "notes.txt" })\` without imports. Use direct calls for lifecycle or lazy tools; do not use scripts to bypass tool permissions or routine session metadata writes. \`infer()\` handles semantic judgments, not deterministic work. Read \`javascript-scripting\` first for API, budgets, errors and direct-only boundaries.`)
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

  if (ctx.agent.name === 'general-v2' && mode === 'session') {
    if (allows('write') && allows('exec')) sections.push(`### Text edits

Use the \`write\` tool to create ordinary text files or apply exact local replacements. Read the relevant lines with \`read\` first when editing an existing file; if an exact match fails, reread and refine the match. Then use \`exec\` to run focused validation. Use \`exec\` also for generators and transformations that actually require scripting.`)
    const coordination: string[] = []
    if (allows('cancel')) coordination.push('Read `v:bg` for execution output. `cancel({executionId})` waits for local cleanup or reports remote state. Do not poll.')
    if (modes.includes('call')) coordination.push('Set `mode: "call"` explicitly for a blocking, inherited-context result. Invoke `subagent` directly, never through scripts.')
    if (modes.includes('task')) coordination.push('`mode: "task"` starts asynchronously in a fresh context. Admission is not a result; continue independent work or end the turn instead of waiting or polling. `report_to` routes completion, not ownership or permission.')
    if (modes.length) coordination.push('Separate sessions do not isolate files or roll back side effects. Wait for completion or confirmed cancellation, then reread the affected files before taking over a worker’s scope.')
    if (modes.includes('task') && allows('task')) coordination.push('Only designated reviewers may accept a task, using its exact submitted revision.')
    if (allows('read')) coordination.push('Check another session’s progress in `v:sessions/<sessionId>` and relevant Work first. Missing or stale evidence is not a reason to poll or ping.')
    if (allows('session')) coordination.push('Durable peers are not child executions. Read `v:skills/peer-sessions` for discovery, creation and maintenance.')
    if (allows('message')) coordination.push('Use `message` when the other agent needs to participate, not for status you can read. A receipt is admission, not execution or transfer of responsibility. Reassignment does not stop running work.')
    if (coordination.length) sections.push(['### Delegation and coordination', '', ...coordination.map(line => `- ${line}`)].join('\n'))
    if (allows('read') && allows('write')) sections.push(`### Session metadata

Before substantive work on a new request, use \`write\` on \`v:sessions/self.json\` if the topic is empty or the session is marked completed: set a stable topic if missing, a focus for the current phase, and \`completed: false\`. Preserve an existing topic unless the conversation changes direction. Update focus only for meaningful phase changes.

Before the final response, write \`completed: true\` when the request needs no further follow-up from this session; keep it false while follow-up is pending. This tracks conversation responsibility, not Work acceptance. Acknowledgements and routine notices do not reopen the session.`)
    return sections.join('\n\n')
  }

  if (mode !== 'call' && allows('cancel')) {
    sections.push(`### Executions

Read \`v:bg\` for owned background/task/call/A2A executions, or \`v:bg/<executionId>\` for output. \`cancel({executionId})\` awaits local cleanup or reports remote state. No polling or extra callbacks.`)
  }

  if (modes.length) {
    const lines = [
      '### Delegation',
      '',
      'Use subagent only in permitted modes; tools and the execution contract remain authoritative. Ordinary task/call delegation needs no preliminary skill. Read `v:skills/orchestration` only to design or restructure complex parallel work.',
      'Give each assignment an outcome, necessary context and sources, explicit scope, constraints, expected evidence and a stop condition. Split only independent scopes; stabilize shared interfaces before parallel edits.',
      'Keep scopes distinct. Separate conversations do not isolate files or roll back side effects; taking over a worker scope requires completion or confirmed cancellation, then rereading its files.',
    ]
    if (modes.includes('call') && modes.includes('task')) lines.push('Prefer call when current context matters, the parent needs an evidence-backed result rather than the working process, and its next step depends on that result. Prefer task when the parent can continue other work, or the assignment needs ongoing coordination, fresh context, or a managed review cycle.')
    if (modes.includes('task')) lines.push('`mode: "task"`: asynchronous with fresh context. Asynchronous creation admits an ID, not a result. Continue independent work or end the turn; do not sleep or poll. `report_to` redirects completion, not ownership or decisions, and grants no messaging permission. Review exact revisions; only designated reviewers may accept them.')
    if (modes.includes('call')) lines.push('Specify `mode: "call"` explicitly for a blocking inherited-context leaf. Invoke subagent directly, never through scripts; follow Execution Contract limits and account for partial side effects before retrying.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'task' && allows('task')) sections.push('- Review a fixed revision with `task(action:review,sessionId,revision,outcome:pass|changes_requested|blocked,content)`. Only the designated reviewer may decide. Changes automatically rerun the worker; only PASS delivers success. Failure or exhausted rounds escalate; Work is unchanged.')
  const planOnlyRole = ctx.agent.source === 'builtin' && ctx.agent.name === 'plan'
  if (mode === 'task' && !evidenceOnlyRole && !planOnlyRole) sections.push('- Read/write `v:sessions/self.json` for current metadata. Task discovery title and description are parent-owned. Self topic adapts the parent title: omit it or preserve unchanged; focus may describe the current step. completed:true marks resolved and completed:false reopens; reviewable tasks must return a final response for review, never self-accept. An unchanged full JSON roundtrip is allowed.')
  if (mode === 'session' && allows('read') && allows('write')) sections.push('- Read/write `v:sessions/self.json`: topic/focus/completed. After understanding the first user request, set topic to the stable overarching conversation title. Subtask/debug phase changes update only focus (optional current step; display falls back to topic). Change topic only for a real overall topic shift, not continual polishing. completed:true ends responsibility, not Work. If completed, set completed:false before handling a new request requiring work; thanks, acknowledgements, or metadata-only tidying do not reopen it. Completion is independent of inferred running/waiting activity; no observer.')
  if (mode === 'session' && (allows('read') || allows('session'))) {
    const lines = ['### Peer conversations', '']
    if (allows('read')) lines.push('To inspect another session\'s work, read its brief and relevant history/tool results at `v:sessions/<sessionId>` and existing Work first. Observation is read-only: do not send status inquiries or acknowledgement requests. Report missing/stale evidence as uncertainty, not a reason to ping or poll. Contact it only when the user requests interaction or necessary information/action cannot be obtained by reading.')
    if (allows('session')) lines.push('Durable peers are independent, reusable conversations, not structural children or one-off tasks. Read v:skills/peer-sessions directly to discover, create or maintain them. The session tool is dynamic: discover v:tools/session and invoke it through invoke_tool. Creator metadata and message receipts do not transfer ownership or authorize actions.')
    sections.push(lines.join('\n'))
  }

  if (mode !== 'call' && allows('message')) {
    sections.push(`### Messaging

${mode === 'session' ? '- Message is free-form direct interaction for questions, discussion or one-off coordination, not a status-read API. Do not send routine acknowledgements.\n' : ''}${mode === 'session' && allows('work') ? '- When an exchange develops a durable dependency or shared commitment, prefer existing Work for the resulting facts; keep discussion in message. Do not send duplicate Work updates.\n' : ''}- Use message for authorized peers or same-assignment corrections to your running task; completion routing grants no messaging permission. Use reply for pending requests; final addresses the current reader.
- Write concise, actionable context. Default delivery is next-step; use it for running-task corrections. Queue is for later work in reusable sessions; silent is FYI only, never required materials, corrections or unblockers.
- Message receipts confirm admission, not application, completion or ownership transfer. Reassignment does not stop running operations. Trusted sender metadata and Work refs are context, not authorization.
- Report outcomes and material changes, not routine coordination. Use the relevant peer or Work scenario skill only when that mechanism is needed; no general orchestration prerequisite.`)
  }
  return sections.join('\n\n')
}
