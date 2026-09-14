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
    ? '- Execution is local and foreground-only. `timeout_ms` must be 1–120000 (default 120000); timeout or cancellation terminates owned processes. Zero, background, detached, and remote execution are forbidden.'
    : '- Provide `timeout_ms` when you expect output; use `timeout_ms: 0` for background execution. On timeout, the process keeps running and appears in `v:bg`.'}
- With \`shell: "node"\`, permitted session tools are available as functions without imports. Pipe helpers: \`pipe\`, \`json\`, \`lines\`, \`pick\`, \`flat\`, \`join\`, \`count\`. See the \`node-scripting\` skill for reference.`)
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'yield')) {
    sections.push(`### Decisions

- **\`yield\`** — Pause for a blocker or consequential decision, not routine choices.
  Invoke it directly, not inside exec/scripts: \`action: "ask"\`, a \`question\`,
  exactly three distinct \`options\`, and \`default_option\` matching one option.
  Your request goes to ${ctx.parentSessionId ? 'your actual parent' : 'the human'}, regardless of completion routing.
  Wait for the tool result; the default is not permission to proceed early.
  Waiting policy comes from session/global configuration, not model arguments.
${modes.some(candidate => candidate !== 'call')
    ? '- When a child asks you, answer with `action: "answer"`, its `request_id`, and one exact `option`. An ordinary message is not an answer.'
    : ''}`.trim())
  }

  if (modes.length) {
    const lines = [
      '### Delegation',
      '',
      '- **`subagent`** — Choose expertise with `agent_type` and execution behavior with `mode`. Role and mode are independent.',
      '- Prefer direct work for simple tasks. State the objective, constraints, required output, and stop condition. Tools remain role-limited; filesystem side effects are not isolated.',
    ]
    if (modes.includes('session')) {
      lines.push('- `mode: "session"`: create a reusable collaborator with its own context. Optionally include initial `task`; use `message` for later assignments when available.')
    }
    if (modes.includes('task')) {
      lines.push('- `mode: "task"`: supply a bounded `task` at creation. Fresh context, one assignment, automatic completion notification; no follow-up assignments.')
      lines.push('- Asynchronous creation returns an admitted ID, not the result. Provide necessary context explicitly. Continue independent work or finish your turn; do not sleep or poll for completion.')
      lines.push('- `report_to` redirects automatic completion instead of returning it to the spawner. It does not change ownership, authorize arbitrary messaging, or redirect decisions.')
    }
    if (modes.includes('call')) {
      lines.push('- `mode: "call"`: supply a bounded `task`; inherit a context snapshot and wait for the final result in this tool invocation. Omitted `agent_type` inherits your role; an explicit role cannot widen capabilities. Internal trace is not copied back; no separate completion event is sent.')
      lines.push('- Invoke call directly as `subagent`, never from exec, scripts, or invoke_tool. It is a leaf: no yield, messaging, further delegation, or deferred work. Deadline: 120 seconds, with up to 10 seconds for cleanup. Permitted exec is local and foreground-only.')
      lines.push('- A blocked call returns its blocker and partial work. Resolve the missing input before invoking again; account for side effects rather than retrying blindly. `report_to` is not supported for call.')
    }
    lines.push(modes.includes('session')
      ? '- At root, omitted `mode` uses the selected role default only if allowed. An invalid default or explicit mode fails.'
      : '- Specify `mode` explicitly; it is required in this scope.')
    lines.push('- Use `preload_tools` for imported tools needed immediately, e.g. `{ "chrome-devtools": [] }`; role restrictions still apply.')
    sections.push(lines.join('\n'))
  }

  if (mode !== 'call' && isToolAllowed(ctx.agent, 'message')) {
    sections.push(`### Messaging

- **\`message\`** — Send to an accessible reusable session, subject to ownership checks.
  Use \`silent: true\` to record without triggering a response. Do not use it to
  continue a one-time task. Completion routing is not blanket messaging permission.`)
  }
  return sections.join('\n\n')
}
