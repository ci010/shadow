# Local agent prompt drafts

In a direct, private Project-owner Web user turn, discover these built-in tool
sources under `v:tools`. Invoke each as the only tool call in its batch.

1. **Save** with `agent_prompt_draft_save({agent_type, markdown})`. Use the exact
   active definition ID (`general` for General), and pass body Markdown,
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

General (`general`), `sub`, `plan`, `verify`, `explore`, and local Project-defined
roles use the same draft store and assembly. Historical `general-v2` and
`general-legacy` draft revisions can still be inspected using their original IDs;
to try one again, save the body as a new `general` draft.
Local host-only definitions (`a2a-text`, `dispatcher`, `encapsulator`, `reflector`,
`soul-reflector`, `work-organizer`) can be saved and inspected, but the draft
interface does not grant their host entry points or start them as ordinary Web
conversations. Their automatic production runs do not select drafts. The local
`a2a-text` definition is distinct from a remote `a2a:<target>`, which cannot
accept a local draft. Publisher-managed Bot/integration roles and the retired
`work-observer` are not selectable through this interface.

New drafts replace the complete `AGENT.md` body for every supported local role,
including built-in `sub`. Role registration, frontmatter, permissions, fixed
contracts, and separate Personal BOT instructions are not replaced. Storage is
Project Home data partitioned by exact registered role and provenance, not by a
caller-supplied path. A revision hashes the full draft snapshot (body and the
bytes of its referenced behavior fragments). Legacy built-in `sub` partial drafts
continue to replace only the historical `sub-behavior.md` fragment, including
revisions originally saved through the generic tool. `sub_override_save` and
`sub_revision` are legacy interfaces; do not pass both revision arguments.

## Authoring role behavior

V2 separates runtime information, fixed execution contracts, and Markdown
behavior. Runtime facts and host contracts are composed in TypeScript. Role
strategy lives in `AGENT.md` or in shared behavior Markdown that it explicitly
references. Built-in V1 baseline rendering remains available for compatibility;
its default role prompt omits migrated V2 suffixes. New full-body drafts use the
same Markdown renderer even when the session uses V1 layout.

Use standalone directives to conditionally render behavior and reference the
built-in catalog (`src/agent/context/behavior-fragments.md`):

```md
<!-- include: discovery -->

<!-- when: tools=read,search; channels=web,discord; modes=session -->
Search first, then inspect the relevant source in context.
<!-- /when -->
```

All predicates must match. Every named `tools` entry must be present in the
native tool surface at prompt assembly; `channels` and `modes` match any listed
value. Lazily discoverable tools are not implicitly native tools. Legacy
`capability:` blocks retain their role/mode checks; in the new renderer they
also check the offered native tools (or a route to the legacy lazy capability).
Includes use
registered IDs, not paths; a shared fragment may have its own `when` blocks.
There is no `else`, nesting, recursive inclusion, or arbitrary evaluation.
Invalid directives and unknown fragments are rejected when saving a new draft.
Preview and execution use the same renderer; a synthetic preview does not have
the scope or tools of a particular live conversation.

## Version evidence and diagnosis

`SHADOW_BUILTIN_PROMPT_VERSION=v1` or `v2` selects assembly for new `general`,
`sub`, `verify`, `plan` and `explore` executions (default `v2`). This is separate
from the role definition ID and draft revision. The old `agentVersionDefaults.general`
config value is accepted for compatibility but no longer selects a definition.
New sessions persist the assembly
and, when selected, the verified draft bytes. Existing sessions without an
assembly pin retain the historical mapping of their definition ID (`general-v2`
→ V2, others → V1). Recorded system prompts are not rewritten. If an ordinary
`general` session without a draft later rebuilds its prompt, it uses the current
canonical General body with its existing assembly pin.

Receipts and session metadata carry `promptRevision`; legacy sub metadata still
carries `subRevision`. Prompt diagnosis identifies role, definition, mode,
assembly, and draft hash, distinguishing an assembled preview from an active or
captured system prompt. A preview is not evidence that a provider saw a prompt.
