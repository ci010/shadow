# Local agent prompt drafts

In a direct, private Project-owner Web user turn, discover these built-in tool
sources under `v:tools`. Invoke each as the only tool call in its batch.

1. **Save** with `agent_prompt_draft_save({agent_type, markdown})`. Use the exact
   definition ID (`general` and `general-v2` are separate), and pass body Markdown,
   not Agent frontmatter. The receipt returns the SHA-256 `revision` and
   `enabled: false`. Saving never enables a draft, changes defaults, or updates a
   running session. Saving and selecting another revision requires no restart.
2. **Inspect without execution** with
   `agent_prompt_draft_preview({agent_type, prompt_revision})`. This assembles a
   synthetic owner-Web prompt for the role's default execution mode, without a
   session, model request, or tool execution. It does not reproduce a particular
   conversation, workspace, or temporary task/call environment.
3. **Run for real**: `agent_prompt_session_create({agent_type, prompt_revision})`
   creates a fresh idle Web session with the selected draft. Open that session by
   its returned ID and send a message to run it. This is **not a sandbox**; normal
   role permissions and execution contracts apply. For temporary task/call runs,
   specify `agent_type` and `prompt_revision` in `subagent`, on an otherwise
   permitted local delegation. With `prompt_revision`, `agent_type` is an exact
   definition ID, not a configurable default alias.

For General iteration, leave the original conversation alone: save another
revision, inspect it, and create a fresh session only when you want to send a real
message. Existing runs and sessions retain their own draft snapshot. Explicit
missing, corrupt, or mismatched revisions fail closed. Omitting a revision in
normal session creation or delegation uses the ordinary prompt, never a saved draft.

## Roles and authority

General (`general`, `general-v2`, `general-legacy`), `sub`, `plan`, `verify`,
`explore`, and local Project-defined roles use the same draft store and assembly.
Local host-only definitions (`a2a-text`, `dispatcher`, `encapsulator`, `reflector`,
`soul-reflector`, `work-organizer`) can be saved and inspected, but the draft
interface does not grant their host entry points or start them as ordinary Web
conversations. Their automatic production runs do not select drafts. The local
`a2a-text` definition is distinct from a remote `a2a:<target>`, which cannot
accept a local draft. Publisher-managed Bot/integration roles and the retired
`work-observer` are not selectable through this interface.

Drafts replace only the role's behavioral Markdown (`sub-behavior.md` for the
built-in `sub`, `AGENT.md` body for other roles). Role registration, frontmatter,
allowlists, permissions, fixed guidance, and mode contracts are independent.
Storage is Project Home data partitioned by exact registered role and provenance,
not by a caller-supplied path. Legacy built-in `sub` retains its existing
`sub-prompt-drafts` namespace, `sub_override_save` and `sub_revision`; do not
supply both revision arguments to `subagent`.

## Version evidence and diagnosis

`SHADOW_BUILTIN_PROMPT_VERSION=v1` or `v2` selects assembly for new `general`,
`sub`, `verify`, `plan` and `explore` executions (default `v2`). This is separate
from the role definition ID and draft revision. New sessions persist the assembly
and, when selected, the verified draft bytes. Existing sessions without an
assembly pin retain the historical mapping of their definition ID (`general-v2`
→ V2, others → V1). Recorded system prompts are not rewritten.

Receipts and session metadata carry `promptRevision`; legacy sub metadata still
carries `subRevision`. Prompt diagnosis identifies role, definition, mode,
assembly, and draft hash, distinguishing an assembled preview from an active or
captured system prompt. A preview is not evidence that a provider saw a prompt.
