---
name: lark-cli-preflight
description: >
  Preflight checks and conventions for calling Lark/Lark-CLI style skills
  ("lark-*"). Encodes reusable safeguards (identity, schema check, dry-run,
  pagination, token handling, and confirmation rules) so agent code can
  programmatically validate operations before executing potentially
  destructive or permission-sensitive actions.
metadata:
  related: [feishu-doc, skill-creator, summarize]
  category: integration
---

# lark-cli-preflight

Purpose
- Provide a short, actionable preflight checklist and concrete examples an
  agent can run before calling any lark-* style skill or the lark-cli OpenAPI
  wrappers. Makes operations safer and repeatable.

When to use
- Before any automated write, delete, overwrite, mail-send, or bulk operation
  against Lark/Feishu-like services.
- When the agent must choose an identity (--as user vs --as bot) or when a
  token/URL needs disambiguation.

Checklist (minimal, enforce in order)
1. Read lark-shared (or equivalent shared auth/permissions doc) and the
   target skill's SKILL.md. Confirm required scopes and identity.
2. Choose identity explicitly: --as user (personal resources / sends) or
   --as bot (app/tenant-scoped). Record reason in logs.
3. Run schema / -h for the intended shortcut/API to discover required
   --params and --data shapes. Do not guess field names.
4. Resolve tokens/URLs to their canonical type (doc token vs file token vs
   wiki node). Use the appropriate resolver call rather than assuming token
   meaning.
5. Prefer provided shortcuts (e.g., +suggestion, +fetch) over raw OpenAPI.
6. For writes/deletes/overwrites: if the API supports --dry-run, run it and
   capture the diff. If dry-run indicates destructive changes, require explicit
   user confirmation (--confirm or a subsequent yes). Log diffs.
7. For bulk operations: respect documented batch limits and rate limits. Use
   automatic pagination or --page-all where supported.
8. For aggregation/analytics: prefer server-side query (data-query) APIs
   rather than fetching all records and aggregating locally.
9. After send/modify operations, poll status endpoints (e.g., send_status,
   import/export tasks) and surface failures.

Concrete examples
- Mail send (safe flow):
  1) Ensure --as user and user is authenticated.
  2) Create draft or preview.
  3) Show preview to user and require `--confirm-send` to proceed.
  4) After send, call send_status and report result.

- Whiteboard upload (safe flow):
  1) docs +fetch → get board_token.
  2) Run whiteboard upload with --dry-run to detect node deletions.
  3) If nodes will be deleted, require explicit confirmation before overwrite.

- Bitable/Base changes:
  1) +field-list / +table-get to obtain exact field names and types.
  2) Construct formulas/lookups only after validating schema.
  3) Use +data-query for aggregates.

Agent integration tips
- Implement a preflight function that returns a structured report:
  {
    needs_identity: boolean,
    identity_suggested: "user"|"bot",
    schema_required: boolean,
    dry_run_available: boolean,
    destructive_changes: boolean,
    confirmation_needed: boolean,
    resolution_steps: string[]
  }
- Persist the preflight report alongside the action (for audit and replay).
- When prompting users for confirmation, include a short human-readable
  diff and the canonical command the agent will run if approved.

Reference
- The quick cheat-sheet saved in memory: [memory/topics/lark-cli-skills.md](memory/topics/lark-cli-skills.md)

Verification
- Manual/human: review a sample of operations and confirm the preflight
  report matches the observed API behavior.
- Optional formal: add unit tests around the preflight resolver that mock
  schema responses, dry-run responses, and token resolvers.

Notes
- Keep this skill atomic and narrowly scoped to preflight checks only.
- If more advanced wrappers are implemented (scripts that execute flows),
  separate them into other skills (e.g., lark-cli-wrappers).
