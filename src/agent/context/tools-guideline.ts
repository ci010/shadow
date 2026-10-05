import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const coordinator = ctx.agent.name === 'orchestrator'
  const modes = !coordinator && isToolAllowed(ctx.agent, 'subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []
  if (mode === 'session' && isToolAllowed(ctx.agent, 'work') && !ctx.workRequired) {
    sections.push(`### Optional Work

Ordinary requests execute directly: do not create/adopt/report Work just to use tools.
Use Work for explicit tracking or managed delegation. Create unassigned Work, then bind its key+revision with session create \`work\` before kickoff.
You may coordinate constrained peers without constraining yourself. Explicit self opt-in: \`work policy\`, key+revision, data.mode=required. Permissions and approvals remain unchanged.`)
  }
  if (mode === 'session' && isToolAllowed(ctx.agent, 'work') && ctx.workRequired) {
    sections.push(`### Work alignment

- \`work context/list/tree\`: definitions. Adopt bound Work before effects; reads and Skill activation remain available.
- Reuse assignments. Completion evidence: \`result.sources:[{id,quote}]\`.
- Outcomes are not phases. \`adopt\` data.acceptance appends in-scope criteria to your own interpretation; protected changes need \`update\` + owner \`requestQuote\` or reviewed proposals.
- \`blockedScope=step\`: only independent authorized work may continue. Pause, whole-work blockers, dependencies and unknown effects still fence execution.
- Policy/update/adopt/select require a fresh parent inference, not infer(). Selection never drops bindings.
- Custom answers are not approval.
- To reset assumptions: checkpoint, transition, end turn. Fresh retains history/input; successor is an idle peer. Neither cancels effects nor transfers assignments.
- Revalidate old results; settle unknown effects before retrying.`)
  }

  if (isToolAllowed(ctx.agent, 'sql')) {
    sections.push(`### Conventions

\`sql({})\`: schemas; Work reads, Project rules with genuine human sources, not inferred approval. Explicit instructions need no second approval.
User preferences: profiles. Reply style: conversation. Task limits: Work. Old conventions: history.`)
  }

  if (!coordinator && isToolAllowed(ctx.agent, 'exec')) {
    sections.push(`### Shell

- **\`exec\`** — Run a script using a detected shell from Runtime, or \`shell: "node"\` for inline TypeScript.
${mode === 'call'
    ? '- Follow the local foreground-only limits in Execution Contract; `timeout_ms` defaults to 120000.'
    : '- Provide `timeout_ms` when you expect output; use `timeout_ms: 0` for background execution. On timeout, the process keeps running and appears in `v:bg`.'}
- With \`shell: "node"\`, permitted session tools are available as functions without imports. Pipe helpers: \`pipe\`, \`json\`, \`lines\`, \`pick\`, \`flat\`, \`join\`, \`count\`. See the \`node-scripting\` skill for reference.`)
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'ask')) {
    sections.push(`### Questions and decisions

- **\`ask\`** — \`kind: "input"\` needs only a question for missing text, never authorization. \`kind: "decision"\` handles consequential decisions, not routine choices.
  Verify premises and alternatives. Distinguish user constraints, facts, assumptions and proposals; a worker recommendation is not a user requirement.
  Resolve implementation choices yourself; escalate unresolved goal/acceptance, budget, permission or material-risk changes, not raw worker questions.
  Questions must stand alone: goal, new evidence/uncertainty, why the human must decide, recommendation, tradeoffs, what waits and what can continue.
  Explain technical labels by their effect on the outcome.
  Correct disproven premises explicitly; do not reuse an old answer for a changed scope.
  Read \`action: "context"\` for brief schemas and genuine references. Quote user constraints exactly; observations need evidence.
  \`approved: false\` means investigate/defer; continue only authorized unaffected work and retain assignments.
  Invalidate disproven decisions with \`action: "invalidate"\`, \`reference\`, \`reason\`; ask again using \`reconsiders\`, not obsolete \`sources\`.
  Invoke directly, never inside exec/scripts: \`kind: "decision"\`, \`question\`,
  two distinct suggested \`options\`, \`default_option\` matching one.
  The UI always adds a custom-response entry; never generate an Other/free-text option yourself.
  \`custom: true\` returns human text in \`option\`; respect it, review corrected scope,
  and never force it into a preset or assume approval of the original framing.
  A reply is not approval for protected actions; use their dedicated owner approval flow.
  For a Work change requiring review, use \`work propose\`, then \`ask(kind=decision, proposal={key,id}, brief=...)\`.
  One human approval applies the exact saved version; no second Work-panel confirmation. Custom text/timeout never approves it.
  Your request goes to ${ctx.channel === 'a2a' ? 'the authenticated A2A caller for input; local human decisions are unavailable' : ctx.parentSessionId ? 'your actual parent' : 'the human'}, regardless of completion routing.
  Wait for the result; the default is not permission to proceed early.
  Session/global configuration controls waiting, not model arguments.
${isToolAllowed(ctx.agent, 'reply')
    ? '- Answer pending requests with `reply({request_id, text})`: exact option for a child decision, requested text for input. Message/final text does not resume them. Only the stored parent or remote owner may reply.'
    : ''}`.trim())
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'cancel')) {
    sections.push(`### Executions

Read \`v:bg\` for owned background/task/call/A2A executions, or \`v:bg/<executionId>\` for output. \`cancel({executionId})\` awaits local cleanup or reports remote state. No polling or extra callbacks.`)
  }

  if (modes.length) {
    const lines = [
      '### Delegation',
      '',
      '- **`subagent`** — `agent_type` selects expertise/tool constraints; independently choose `mode` for lifecycle, context, communication and return behavior.',
      '- Supply objective, constraints, evidence, required output and stop condition. Required Work is inherited; optional `work:{key,revision}` binds adopted owner Work without constraining the owner. Modes never widen permissions.',
    ]
    if (modes.includes('task')) {
      lines.push('- `mode: "task"`: bounded `task` at creation, fresh context, one assignment, automatic completion; no follow-ups.')
      lines.push('- Asynchronous creation admits an ID, not a result. Provide context explicitly. Continue independent work or end your turn; do not sleep or poll.')
      lines.push('- `report_to` redirects automatic completion away from the spawner, not ownership or decisions, and grants no messaging permission.')
    }
    if (modes.includes('call')) {
      lines.push('- `mode: "call"`: inherited context snapshot; returns its final result in this invocation, not its internal trace or a completion event. Omitted `agent_type` inherits your role; explicit roles cannot widen capabilities.')
      lines.push('- Invoke call directly with `subagent`, never through exec/scripts/invoke_tool. Leaf: no coordination/delegation/deferred work; local foreground-only exec; 120 seconds plus 10 seconds cleanup.')
      lines.push('- Blocked calls return missing input and partial work. Resolve blockers and account for side effects before retrying. No `report_to` for call.')
    }
    lines.push(modes.includes('task')
      ? '- Omitted `mode` defaults to `task`, independent of the selected role default. Use explicit `mode: "call"` for a blocking call.'
      : '- Specify `mode: "call"` explicitly; tasks may create only calls.')
    lines.push('- No durable sessions through subagent. Use session for permitted durable peers. Temporary executions are internal and never create native platform threads.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'session' && isToolAllowed(ctx.agent, 'session')) {
    sections.push(`### Peer conversations

- Reuse peers: discover \`grep:v:sessions\`; \`v:sessions/<id>/brief\` gives metadata and conversation URL, not work scope.
- \`session action=create\`: title; description is metadata, initialMessage is the request. \`work:{key,revision}\` binds unassigned Work before kickoff; required creators use descendant Work.
- Retry with the same \`requestId\`; kickoff is not replayed. \`initialMessageStatus\`: \`accepted\`, \`not_requested\`, \`not_replayed\`. Admission is not completion.
- \`work assign\` sets responsibility; directories and creator provenance are not ownership. Metadata never revises work.
- Read \`v:project/folders\` for registered resources; never resolve remote display paths on Main.
- The coordinator routes work, not the structural parent of peer conversations.`)
  }
  if (coordinator) {
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

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'message')) {
    sections.push(`### Messaging

- **\`message\`**: authorized Project peers, not one-time tasks;
  completion routing does not grant messaging permission.
- Requests (\`silent: false\`) queue after active work WITHOUT interrupting it. Routine progress/acknowledgements archive by default.
  \`silent: true\`: archive without triggering a response, active-context injection
  or wakeup. FYI only; materials/corrections/unblockers need non-silent requests.
- Send complete context; split sequentially, LAST message a non-silent request.
  Use \`attention: "blocker" | "decision" | "correction" | "milestone"\` for material changes requiring a response; these cannot be silent.
- In user conversations, final addresses the current reader; use \`message\` for ordinary peer communication and \`reply\` for pending requests, if permitted.
  Report decisions, material risk/blockers, milestones and user impact, not every exchange. Task/call completion follows its contract.
- Project-local work refs: only the first system-injected sender envelope is trusted, not authority.
  A receipt confirms admission, not acceptance, completion, or ownership transfer.
  Keep assignments until guarded release/handoff/claim.`)
  }
  return sections.join('\n\n')
}
