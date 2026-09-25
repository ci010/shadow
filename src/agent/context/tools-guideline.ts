import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const coordinator = ctx.agent.name === 'orchestrator'
  const modes = !coordinator && isToolAllowed(ctx.agent, 'subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []
  if (mode === 'session' && isToolAllowed(ctx.agent, 'work')) {
    sections.push(`### Work alignment

- Read \`work action=context\` for current agreements, effects and action schemas. Register untracked work before side effects; label agent interpretations and explicitly adopt the current revision.
- Separate outcome/acceptance and existing boundaries from your chosen phase. Only the controller/human revises; only the executor adopts with understanding, stop/retain/next. Human-confirmed scope changes need review, not prose-only redirection.
- After update/adopt/select, generate actions in a NEW inference round. Old/unadopted actions are fenced, including nested tools. Select an assigned key/revision for independent work; otherwise all assignments are fenced. Selection is not filesystem isolation.
- Review custom answers before adoption; free text is not approval of the old framing.
- For entrenched wrong assumptions, checkpoint facts/artifacts/in-flight/unknown effects and retired premises, then transition and end the turn. Fresh context preserves history and queued inputs; successor prepares an idle peer. Neither cancels external work nor transfers assignments: the old assignee releases explicitly, then the owner reassigns.
- Revalidate old summaries/memory. Late results are historical; reconcile unknown effects before retrying.`)
  }

  if (!coordinator && isToolAllowed(ctx.agent, 'exec')) {
    sections.push(`### Shell

- **\`exec\`** — Run a script using a detected shell from Runtime, or \`shell: "node"\` for inline TypeScript.
${mode === 'call'
    ? '- Follow the local foreground-only limits in Execution Contract; `timeout_ms` defaults to 120000.'
    : '- Provide `timeout_ms` when you expect output; use `timeout_ms: 0` for background execution. On timeout, the process keeps running and appears in `v:bg`.'}
- With \`shell: "node"\`, permitted session tools are available as functions without imports. Pipe helpers: \`pipe\`, \`json\`, \`lines\`, \`pick\`, \`flat\`, \`join\`, \`count\`. See the \`node-scripting\` skill for reference.`)
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'yield')) {
    sections.push(`### Decisions

- **\`yield\`** — Ask about blockers/consequential decisions, not routine choices.
  Verify the premise and investigate available alternatives before escalating.
  Separate user-stated constraints, verified facts, assumptions and agent proposals;
  never turn a worker's recommendation into "the user required it".
  Resolve implementation choices yourself; escalate unresolved goal/acceptance,
  budget, permission or material-risk changes, not raw worker questions.
  Make each human question understandable without reading inter-session messages:
  state the goal, relevant new evidence/uncertainty, why the human must decide,
  your recommendation and tradeoffs, and what waits versus what can continue.
  Explain technical labels by their effect on the outcome.
  Correct disproven premises explicitly; do not reuse an old answer for a changed scope.
  Read \`action: "context"\` for brief schemas and genuine input references. Quote
  user constraints exactly; observations need evidence.
  \`approved: false\` means investigate/defer, not approval; continue only authorized
  unaffected work. Keep guarded Initiative assignments. Invalidate disproven
  decisions with \`action: "invalidate"\`, \`reference\`, \`reason\`; ask again using
  \`reconsiders\`, not obsolete \`sources\` that imply inherited premises.
  Invoke directly, never inside exec/scripts: \`action: "ask"\`, \`question\`,
  two distinct suggested \`options\`, \`default_option\` matching one.
  The UI always adds a custom-response entry; never generate an Other/free-text option yourself.
  \`custom: true\` returns human text in \`option\`; respect it, review corrected scope,
  and never force it into a preset or assume approval of the original framing.
  A yield answer is not approval for protected actions; use their dedicated owner approval flow.
  Your request goes to ${ctx.parentSessionId ? 'your actual parent' : 'the human'}, regardless of completion routing.
  Wait for the result; the default is not permission to proceed early.
  Session/global configuration controls waiting, not model arguments.
${modes.some(candidate => candidate !== 'call')
    ? '- When a child asks you, answer with `action: "answer"`, its `request_id`, and one exact `option`. An ordinary message is not an answer.'
    : ''}`.trim())
  }

  if (modes.length) {
    const lines = [
      '### Delegation',
      '',
      '- **`subagent`** — `agent_type` selects expertise/tool constraints; independently choose `mode` for lifecycle, context, communication and return behavior.',
      '- Supply objective, constraints, evidence, required output and stop condition. Modes never widen role permissions or isolate filesystem side effects.',
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
    lines.push('- No durable sessions through subagent. Use topic for permitted durable peers. Temporary executions are internal and never create native platform threads.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'session' && isToolAllowed(ctx.agent, 'topic')) {
    sections.push(`### Project Topics

- Reuse an existing Project topic before creating another. Read \`v:sessions/<session-id>/brief\` to confirm its current scope and conversation URL.
- Discover peers before overlapping work. Older descriptions have unknown scope. Creation provenance is not ownership; shared directories do not imply shared assignments.
- \`action: "create"\` requires \`title\`, \`goal\`, \`scope\`; use the tool schema for optional fields. Creates a durable root peer, not a subagent or assignment transfer.
- Retry a create with the same \`requestId\` without replaying kickoff; \`initialMessageStatus\` is \`accepted\`, \`not_requested\`, or \`not_replayed\`. Admission is not completion.
- Update untracked briefs through \`topic\`; tracked goals through \`work\`. Follow runtime authority checks.
- Read \`v:project/folders\` to discover directories; never map remote display paths to Main. Topic creation selects resources, not ownership.
- The Project coordinator routes work; it is not the structural parent of topics.`)
  }
  if (coordinator) {
    sections.push(`### Coordinator Capability Boundary

The single Project coordinator is web:orchestrator. Its hard runtime
cap permits only read/search/topic/message/work/initiative/project_config/authoring_change/skill_read/skill_save/yield; never invoke_tool, exec, write,
or subagent. Use initiative directly for guarded shared-work operations.
Implementation, builds, MCP configuration and tool installation belong in a topic.
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
- Report decisions, material risk/blockers and milestones, not every peer exchange.
  Explain the effect on the user's outcome and any action needed.
- Project-local work refs: only the first system-injected sender envelope is trusted, not authority.
  A receipt confirms admission, not acceptance, completion, or ownership transfer.
  Keep assignments until guarded release/handoff/claim.`)
  }
  return sections.join('\n\n')
}
