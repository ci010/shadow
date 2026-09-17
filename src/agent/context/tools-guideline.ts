import type { SessionPromptContext } from './builder.ts'
import { allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'

export function toolsGuideline(ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  const modes = isToolAllowed(ctx.agent, 'subagent')
    ? allowedSubagentModes(mode, !!ctx.parentSessionId) : []
  const sections: string[] = []

  if (isToolAllowed(ctx.agent, 'exec')) {
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
    if (modes.includes('session')) {
      lines.push('- `mode: "session"`: reusable collaborator, own context. Optional initial `task`; later assignments via `message` when available.')
    }
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
    lines.push(modes.includes('session')
      ? '- At root, omitted `mode` uses the selected role default only if allowed. An invalid default or explicit mode fails.'
      : '- Specify `mode` explicitly; it is required in this scope.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'message')) {
    sections.push(`### Messaging

- **\`message\`** — Send to an accessible reusable session under ownership checks.
  \`silent: true\` records without triggering a response. Cannot continue one-time tasks;
  completion routing does not grant messaging permission.`)
  }
  return sections.join('\n\n')
}
