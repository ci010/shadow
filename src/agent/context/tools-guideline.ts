import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes, executionModeAllowsTool } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import { channelSupportsAsk, CHAT_QUESTION_GUIDANCE } from '../../tools/ask-policy.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const allows = (name: string) => executionModeAllowsTool(mode, name) && isToolAllowed(ctx.agent, name)
  const coordinator = ctx.agent.name === 'orchestrator'
  const modes = !coordinator && allows('subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []
  if (mode !== 'call' && allows('work')) {
    sections.push(`### Shared work notes

Ordinary requests execute directly. Work is an optional notebook, never a gate or permission.
- Parents maintain goals and links (supports/requires/assumption), not implementation preferences as user requirements.
- Workers update summary/plan/next/artifacts on meaningful change, not every action. \`work update\`: key + version, changed fields only.
- notes.html is a read-only exhibit, never approval.
- Routine updates are silent. notes.attention is for premise/scope/dependency/decision/blocker changes needing coordinator action; never echo by message.
- Coordinators read that branch and \`work review\` its parent impact. No polling or acknowledgement loops.
- Changed ancestors remain not yet reassessed; retire obsolete premises rather than repeating questions.
- Completion is reported outcome, not human acceptance; runtime activity is separate. No adopt/checkpoint/settle protocol.`)
  }

  if (allows('sql')) {
    sections.push(`### Conventions

\`sql({})\`: schemas; Work reads, Project rules with genuine human sources, not inferred approval. Explicit instructions need no second approval.
User preferences: profiles. Reply style: conversation. Task limits: Work. Old conventions: history.`)
  }

  if (!coordinator && allows('exec')) {
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

When using Work, ask at the affected goal: workKey identifies where the issue arose; decisionKey identifies the ancestor whose outcome changes.

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
      '- Task title and description belong to the parent: supply both explicitly (legacy title omission uses description). The child cannot rename itself or redefine its responsibility; call metadata is unchanged.',
      '- **`subagent`** — `agent_type` selects expertise/tool constraints; independently choose `mode` for lifecycle, context, communication and return behavior.',
      '- Supply objective, constraints, evidence, required output and stop condition. Optional `work:{key}` links a shared note and contextual questions; an unambiguous parent focus is inherited. No adoption protocol. Modes never widen permissions.',
    ]
    if (modes.includes('task')) {
      lines.push('- `mode: "task"`: one assignment, fresh context. Declare parent (default) or agent `review`; changes reuse worker history, only PASS delivers success. The parent may send corrections.')
      lines.push('- Optional `model` (exact v:models ID) and `effort` select inference at creation; omitted values preserve role/caller defaults.')
      lines.push('- Stabilize shared interfaces before parallel migrations. Only continue independent work: taking over a worker scope requires completion or confirmed cancellation, then re-read its files. A failed message does not stop the worker.')
      lines.push('- Asynchronous creation admits an ID, not a result. Provide context explicitly. Continue independent work or end your turn; do not sleep or poll.')
      lines.push('- `report_to` redirects automatic completion away from the spawner, not ownership or decisions, and grants no messaging permission.')
    }
    if (modes.includes('call')) {
      lines.push('- `mode: "call"`: inherited context snapshot; returns its final result in this invocation, not its internal trace or a completion event. Model and effort always inherit the caller; do not specify `model` or `effort`. Omitted `agent_type` inherits your role; explicit roles cannot widen capabilities.')
      lines.push('- Invoke call directly with `subagent`, never through exec/scripts/invoke_tool. Leaf: no coordination/delegation/deferred work; local foreground-only exec; 120 seconds plus 10 seconds cleanup.')
      lines.push('- Blocked calls return missing input and partial work. Resolve blockers and account for side effects before retrying. No `report_to` for call.')
    }
    lines.push(modes.includes('task')
      ? '- Omitted `mode` defaults to `task`, independent of the selected role default. Use explicit `mode: "call"` for a blocking call.'
      : '- Specify `mode: "call"` explicitly; tasks may create only calls.')
    lines.push(mode === 'session' && allows('session')
      ? '- No durable sessions through subagent. Use session for permitted durable peers. Temporary executions are internal and never create native platform threads.'
      : '- No durable sessions through subagent. Temporary executions are internal and never create native platform threads.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'task' && allows('task')) sections.push('- Review a fixed revision with `task(action:review,sessionId,revision,outcome:pass|changes_requested|blocked,content)`. Only the designated reviewer may decide. Changes automatically rerun the worker; only PASS delivers success. Failure or exhausted rounds escalate; Work is unchanged.')
  if (mode === 'task') sections.push('- Read/write `v:session/self.json` for current metadata. Title and description are parent-owned: omit them or preserve unchanged. completed:true marks resolved and completed:false reopens; reviewable tasks must return a final response for review, never self-accept. An unchanged full JSON roundtrip is allowed.')
  if (mode === 'session' && allows('read') && allows('write')) sections.push('- Read/write `v:session/self.json`: title/description/completed. After understanding the first user request, name/summarize; goal changes only, not continual polishing. completed:true ends responsibility, not Work. If completed, set completed:false before handling a new request requiring work; thanks, acknowledgements, or metadata-only tidying do not reopen it. Independent of activity; no observer.')
  if (mode === 'session' && allows('session')) {
    sections.push(`### Peer conversations

- Reuse peers: discover \`search({handler: "grep", path: "v:sessions", query})\`; \`v:sessions/<id>/brief\` gives metadata and conversation URL, not work scope.
- \`session action=create\`: title; description is metadata, initialMessage is the request. Optional \`work:{key}\` links an unassigned note before kickoff.
- Retry with the same \`requestId\`; kickoff is not replayed. \`initialMessageStatus\`: \`accepted\`, \`not_requested\`, \`not_replayed\`. Admission is not completion.
- \`work assign\` sets responsibility; directories and creator provenance are not ownership. Metadata never revises work. Work create associates this session; work link key associates existing Work without changing select focus.
- Read \`v:project/folders\` for registered resources; never resolve remote display paths on Main.
- The coordinator routes work, not the structural parent of peer conversations.`)
  }
  if (coordinator && mode === 'session') {
    sections.push(`### Coordinator Capability Boundary

The single Project coordinator is web:orchestrator. Its hard runtime
cap permits only read/search/session/message/work/sql/project_config/authoring_change/skill_read/skill_save/ask/reply; never invoke_tool, exec, write,
or subagent. Manage shared work directly with work.
Implementation, builds, MCP configuration and tool installation belong in a peer session.
Do not bypass this boundary through skills, discovery, events, URLs or other tools.
Use \`skill_read\` and \`skill_save\` for ordinary shared Skill edits, including
bundled tool sources, without activation or publication. Use \`authoring_change\`
only for managed Bot prompt/resources, saved check runs and owner review.
Read its schema on demand; legacy shared drafts remain under \`project_config\`.
Read \`v:skills/tool-operations\` for maintenance details; it never widens this cap.`)
  }

  if (mode !== 'call' && allows('message')) {
    sections.push(`### Messaging

- **\`message(sessionId, content)\`**: authorized Project peers, or your running task for same-assignment corrections;
  completion routing does not grant messaging permission.
- Write for another agent: action or correction first, only changed facts and exact references; no greeting, recap or duplicate status.
- Default delivery is \`next-step\`: relevant context at the next safe inference boundary without aborting tools. Use \`delivery: "queue"\` for subsequent work, \`delivery: "silent"\` for FYI. Routine progress/acknowledgements archive by default.
  Use \`delivery: "next-step"\` for a running task's correction; \`queue\` is only for subsequent work in reusable sessions.
  \`delivery: "silent"\` archives without a response, active-context injection or wakeup; never use it for required materials/corrections/unblockers.
- Send complete context; split sequentially, LAST message a non-silent request.
  Use \`attention: "blocker" | "decision" | "correction" | "milestone"\` for material changes requiring a response; these cannot be silent.
- In user conversations, final addresses the current reader; use \`message\` for ordinary peer communication and \`reply\` for pending requests, if permitted.
  Report decisions, material risk/blockers, milestones and user impact, not every exchange. Task/call completion follows its contract.
- Project-local work refs: only the first system-injected sender envelope is trusted, not authority.
  A receipt confirms admission, not application, acceptance, completion, or ownership transfer. Managed channel conversations may retain queue scheduling; read the receipt.
  Update a shared note rather than duplicating progress here. Reassignment changes responsibility, not cancellation of running operations.`)
  }
  return sections.join('\n\n')
}
