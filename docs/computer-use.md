# Official desktop MCP

Shadow includes the complete official `vercel-labs/agent-desktop` v1.2.0 MCP as the
reserved built-in source `agent-desktop`, on macOS, Windows and Linux x64/arm64.
Initialize it with `invoke_tool` source `agent-desktop`, args `{}`, then use the exact
returned official tool names and schemas. Initialization only discovers tools.
There are no Shadow `computer_setup`, `computer_observe` or `computer_act` wrappers.

## Access is broad, not a window sandbox

The official tools can access the logged-in user's applications, screenshots,
accessibility tree, input, clipboard and application launch within OS permissions.
They are not restricted to a selected window, ten-minute lease or custom action
allowlist; Shadow and browser windows are not excluded. Application content goes
to the configured model and can be retained in normal tool history. Do not rely
on the removed transient-observation/redaction behavior.

Host-device authorization, Main local-executor enablement and role permissions
remain in force. The source requires the owning Web conversation. It explicitly
operates **Main's desktop**, even when a Child workspace is selected. It cannot
operate the Child desktop, and it is not available on a coordinator with Main
execution disabled. Consequential actions still use the existing user confirmation
flow. OS permission changes and system dependency installation are never automatic.
Browser MCP is a separate Main-host service.

## Cancellation and uncertainty

All official tool calls share a host-wide FIFO desktop lock across Projects.
Cancellation sends the official request cancellation; unknown dispatched results
are never replayed. EOF alone is not cancellation because official MCP drains
in-flight work. The host bounds direct-child shutdown, using Unix TERM followed
by KILL after three seconds or Windows direct termination. It does not promise to
forcibly terminate every platform helper or undo applications/clipboard changes.

A successful official response, even an official error, releases the lock normally.
When cancellation, timeout or transport failure leaves a dispatched outcome unknown,
subsequent desktop actions are blocked. Inspect/reconcile the intended effect,
ensure desktop activity has stopped, then restart Shadow before resuming. Do not
bypass the block through a different conversation or source. Intentionally launched
user applications and persistent clipboard effects are not rollback targets.

For pinned asset preparation, integrity and native validation limitations, see
[agent-desktop integration](agent-desktop.md).
