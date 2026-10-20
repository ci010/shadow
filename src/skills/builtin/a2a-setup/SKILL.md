---
name: a2a-setup
description: "Set up a missing A2A Codex or Claude Code target from a user-installed local CLI: detect version, configure an explicit workdir and permission policy, start, status, stop and recover. No CLI installation, login or paid probe."
metadata:
  category: tools
---

# Local coding-agent setup

Use structured `a2a_setup`, discovered with
`search({handler:"grep",path:"v:tools",query:"a2a_setup"})`, then
`invoke_tool({name:"a2a_setup",args:{action:"detect",type:"codex"}})`.
This requires a local admin Web session with a selected authorized local folder.
It is unavailable to remote agents, group chats, non-admins and borrowed leaf calls.
Reading this skill grants neither setup permission nor A2A delegation rights.

1. Read `v:agents` first. Reuse an appropriate configured target; do not adopt
   existing native chats or contact arbitrary URLs.
2. Detect `codex` or `claude`. This runs only the installed CLI's `--version`
   with bounded output/time, returning a version, never raw output. It does not
   verify login, billing, supported policy flags or successful inference. Ask
   the operator to install/login separately if needed; never collect credentials.
3. Obtain authorization for the workdir and explicit permission policy. Select
   that folder as the current session workdir before configuring. Use for example
   `{action:"configure",name:"codex-local",cwd:"<current absolute local workdir>",backend:{type:"codex",sandbox:"read-only"}}`.
   Codex permits only `read-only` or explicitly authorized `workspace-write`;
   network access stays disabled. Claude requires an explicit tools array, e.g.
   `{type:"claude",tools:["Read","Glob","Grep"]}` or an empty list. Adding Bash,
   writes, or network tools is a material authorization choice, not a recovery
   fallback. Setup never silently changes policy, installs a CLI or runs a prompt.
4. `{action:"start",name:"codex-local"}` starts a localhost-only bridge and
   hot-registers `a2a:codex-local` in the current Project. No backend restart is
   needed, including Projects with no original A2A configuration. Generated
   credentials remain private, never in tool results, chat or ambient environment.
5. Read `v:agents`, then use existing subagent/message/read/cancel/reply as
   described in `v:skills/a2a`. Only authorized task text leaves Shadow; no caller
   role, transcript, tools or grants are inherited. Native coding chats are never
   enumerated or resumed. New Shadow remote conversations create independent CLI
   sessions; subsequent messages resume only their own bridge session.

`{action:"status",name:"codex-local"}` reports local listener state and saved
policy, not paid provider health. Provider failures are reported by normal A2A
execution tracking; do not auto-retry uncertain tasks. `stop` shuts down the owned
bridge and active tasks, removes hot discovery and clears the in-memory token.
It does not undo coding effects or delete saved session history.

Configuration and isolated bridge session history persist in private Project
storage. Every backend restart deliberately leaves bridges stopped: select the
saved workdir and call `start` explicitly. The selected port is retained; a port
conflict fails closed rather than switching endpoints. Existing remote histories
are unavailable while stopped; starting restores the target without replaying
interrupted tasks. Stop before maintenance and inspect uncertain/interrupted
executions before continuing. Names and policies cannot be overwritten by setup;
choose a distinct name for a newly authorized policy. Copilot is unsupported.

The bridge requires an already user-installed CLI visible to the Shadow host's
PATH (official Windows npm shims are resolved to JS without a shell). Packaged
Shadow includes the bridge adapter; it does not depend on a repository checkout,
`tsx`, or vendor SDKs. CLI-specific restrictions still depend on installed CLI
support and fail closed when unsupported. This is not an OS sandbox: the CLI runs
under the host user and intentionally uses that user's CLI authentication.

## Recovery and explicit executable selection

Use `{action:"list"}` to discover saved bridge names, policies, workdirs and
whether a port is allocated, including configured-but-never-started bridges
following a backend restart. Listing never reveals credentials. `status` takes
one listed name. Both `detect` and `configure` accept optional `executable`, an
absolute path to a native CLI executable or official `.js`/`.mjs` entrypoint;
this is useful when desktop PATH differs from the operator's terminal. Never
supply a shell command, URL, wrapper that widens permissions, or downloaded CLI.

Failures return `{error:{code,message}}` without raw CLI/OS diagnostics:
- `SETUP_DENIED`: use a durable local admin Web session and authorized folder.
- `CLI_UNAVAILABLE`: select an already installed absolute executable, or ask
  the operator to install/login separately; setup does neither.
- `INVALID_ARGUMENTS`: consult the schema and specify an explicit policy.
- `NAME_EXISTS` / `UNKNOWN_BRIDGE`: inspect `list`; do not overwrite policies.
- `WORKDIR_MISMATCH`: select the saved authorized workdir before starting.
- `PORT_IN_USE`: stop the conflicting owner, then retry the same endpoint.
- `UNSAFE_STATE_DIRECTORY`: do not redirect bridge state into the coding folder.
- `BUSY`, `CANCELLED`, `SETUP_CLOSED`: inspect status after the operation or wait
  for the owning Project runtime; do not infer that a paid task was run.
- `LOCAL_OPERATION_FAILED`: inspect local filesystem access and CLI version
  support; do not widen policy or expose credential files for diagnosis.

Shutdown waits for pending startup and attempts cleanup of every owned bridge.
Cancellation during startup cannot hot-register a listener after shutdown.
