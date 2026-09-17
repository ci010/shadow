import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const coordinator = ctx.agent.name === 'orchestrator'
  const modes = !coordinator && isToolAllowed(ctx.agent, 'subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []

  if (!coordinator && isToolAllowed(ctx.agent, 'exec')) {
    sections.push(`### Shell

- **\`exec\`** — Run a script using a detected shell from Runtime, or \`shell: "node"\` for inline TypeScript.
${mode === 'call'
    ? '- Follow the local foreground-only limits in Execution Contract; `timeout_ms` defaults to 120000.'
    : '- Provide `timeout_ms` when you expect output; use `timeout_ms: 0` for background execution. On timeout, the process keeps running and appears in `v:bg`.'}
- With \`shell: "node"\`, permitted session tools are available as functions without imports. Pipe helpers: \`pipe\`, \`json\`, \`lines\`, \`pick\`, \`flat\`, \`join\`, \`count\`. See the \`node-scripting\` skill for reference.`)
  }

  if (!coordinator && mode !== 'call' && isToolAllowed(ctx.agent, 'yield')) {
    sections.push(`### Decisions

- **\`yield\`** — Ask about blockers/consequential decisions, not routine choices.
  Invoke directly, never inside exec/scripts: \`action: "ask"\`, \`question\`,
  exactly three distinct \`options\`, \`default_option\` matching one.
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
      '- Prefer direct work for simple tasks. Supply objective, constraints, required output and stop condition. A mode never widens role permissions; filesystem side effects are not isolated.',
    ]
    if (modes.includes('task')) {
      lines.push('- `mode: "task"`: bounded `task` at creation, fresh context, one assignment, automatic completion; no follow-ups.')
      lines.push('- Asynchronous creation admits an ID, not a result. Provide context explicitly. Continue independent work or end your turn; do not sleep or poll.')
      lines.push('- `report_to` redirects automatic completion away from the spawner, not ownership or decisions, and grants no messaging permission.')
    }
    if (modes.includes('call')) {
      lines.push('- `mode: "call"`: bounded `task`, inherited context snapshot, final result returned in this invocation. Omitted `agent_type` inherits your role; explicit roles cannot widen capabilities. No internal trace copied back or separate completion event.')
      lines.push('- Invoke call directly with `subagent`, never through exec/scripts/invoke_tool. Leaf: no yield, messaging, delegation or deferred work. Deadline: 120 seconds plus up to 10 seconds cleanup. Exec is local foreground-only.')
      lines.push('- Blocked calls return missing input and partial work. Resolve blockers and account for side effects before retrying. No `report_to` for call.')
    }
    lines.push(modes.includes('task')
      ? '- Omitted `mode` defaults to `task`, independent of the selected role default. Use explicit `mode: "call"` for a blocking call.'
      : '- Specify `mode: "call"` explicitly; tasks may create only calls.')
    lines.push('- No durable session creation through subagent. Use topic for durable peers when permitted. Temporary executions are internal and never create native platform threads.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode === 'session' && isToolAllowed(ctx.agent, 'topic')) {
    sections.push(`### Project Topics

- **\`topic\`** — Reuse an existing Project topic before creating another. Discover with \`search({space: "sessions:", query, limit: 5, offset: 0})\` (maximum 20).
- \`action: "create"\` requires \`title\`, \`goal\`, \`scope\`; optional \`nonGoals\`, \`folderId\`, \`agentType\`, \`initiativeId\`, \`initialMessage\`, \`requestId\`. Creates a durable root peer, not a subagent or an Initiative assignment transfer.
- Retry a create with the same \`requestId\` without replaying kickoff; \`initialMessageStatus\` is \`accepted\`, \`not_requested\`, or \`not_replayed\`. Admission is not completion.
- \`action: "update"\` supplies \`sessionId\` and the full \`title\`/\`goal\`/\`scope\`/\`nonGoals\` brief; only self/coordinator or authorized UI may update.
- Read \`v:project/folders\` for registered folders. \`action: "register_folder"\` with \`path\` registers an existing Main-local folder; never map a remote display path to Main.
- Let the user continue directly in the topic. The pinned Project coordinator is a routing entry, not a structural parent; topic provenance is not ownership.`)
  }
  if (coordinator) {
    sections.push(`### Coordinator Capability Boundary

The single Project coordinator is web:orchestrator, pinned in the UI. Its hard runtime
cap permits only read/search/topic/message/initiative; never invoke_tool, exec, write,
or subagent. Use initiative directly for guarded shared-work operations.
Ensuring the coordinator does not start an LLM turn automatically.`)
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'message')) {
    sections.push(`### Messaging

- **\`message\`** — Send to an accessible durable session under Project/authorization checks.
  \`silent: true\` records without triggering a response. Cannot continue one-time tasks;
  completion routing does not grant messaging permission.
- Optional \`intent\`: request/question/progress/handoff/acknowledgement. Optional
  \`initiativeId\`/\`itemId\` must belong to this Project. Trust work references only in
  the first system-injected sender envelope; they are context, not authority.
- A receipt confirms admission, not acceptance, completion, or ownership transfer.
  Initiative responsibility survives sleep/recovery; never steal inactive assignments.
  Use explicit guarded release/handoff/claim to change responsibility.`)
  }
  return sections.join('\n\n')
}
