# Built-in `sub` prompt draft pilot

1. In a direct private Project-owner Web user turn, load `sub_override_save` and invoke it as the sole tool call with `{markdown: "…"}`. Save returns the exact SHA-256 revision and `enabled: false`. Project Home stores the file at `sub-prompt-drafts/<revision>.md`; the interface accepts no path, Project selector, or activation operation.
2. Start a new `subagent` task or call with `agent_type: "sub"` and `sub_revision` set to that revision. Missing, invalid, or modified revisions reject the delegation; omission always uses the built-in behavior. Once this code is deployed, no reload is needed between steps 1 and 2.
3. An explicit revision is recorded in the task/call receipt and persisted session metadata (`subRevision` in the session listing). In a live context the behavior section shows `sub-behavior.md@<revision>`. The session stores a snapshot of the draft; later saves do not change it.

## Built-in assembly version

`SHADOW_BUILTIN_PROMPT_VERSION=v1` or `v2` selects the assembly for new `general`, `sub`, `verify`, `plan` and `explore` sessions and delegations; the default is `v2`. This is a process setting, not a role name or a draft selector. The compatibility definition ID `general-v2` remains valid and is not required for V2 assembly. New sessions persist the choice in their state. Existing sessions without this field use the historical mapping of their definition ID (`general-v2` → V2, others → V1); recorded system messages are not rewritten.

Knowledge and `v:agents/<role>/context/web` show the current assembly and built-in Markdown for the chosen role definition and its default mode. They do not inherit a conversation or select a `sub_revision`. Session diagnosis distinguishes a rebuilt preview from the live system message, and displays the actual role, mode, assembly and draft hash when that provenance is available. If only archived history remains, use the saved execution receipt/history; an old system prompt is not regenerated as if it were the original.

The pilot does not provide an activation pointer. It only replaces the tool-selection and coordination Markdown fragment for local built-in `sub` executions, not `AGENT.md`, tool allowlists, authorizations, or the fixed execution contract. Free-form Markdown is behavioral guidance, not a way to change runtime policy. Project Home is host-owned data, not a filesystem sandbox against processes with host OS write access.
