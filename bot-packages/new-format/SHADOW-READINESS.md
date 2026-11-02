# Shadow personal BOT — prepared, not deployed

## Durable source

- Registered Default Folder: `shadow` (`991eee02-ea7b-40d4-b76f-3f31fa7dc3b0`).
- Relative source: `bot-packages/new-format/shadow`.
- Files: `BOT.md`, `bot.json` only. This report is deliberately outside the package.
- Parser: `parseBot(snapshotBotDirectory(source))` succeeded.
- Exact frozen revision (SHA-256):
  `d1d16d0459b3d90a57fb56c76f33f528c446597aa86210767a32a9dba5b5fba9`.

## Selected behavior

Explicit `personal` mode references the existing Default personal QQ connection;
its connection identifier is a reference, not a credential or owner identity.
The selected role is `general`: the correct Project `config/agents` directory
has no custom overrides, and the persisted logical QQ session metadata has an
implicit general role and session mode. No message history or private memory was
read or embedded to prepare this source. BOT.md adds public, generic personal
assistant instructions while retaining the ordinary role and Project context.

Personal mode has no packaged custom tools: schema rejects tool modules,
service bindings/scopes and embedded skills. Ordinary role tools and dynamic
skills remain available under existing permission controls. BOT.md cannot pair
an owner, set admin, modify connection purpose or bypass revocation.

## Deployment boundary

These are source files only. No live configuration, pairing, session state,
service, deployment directory or Git state was changed. No deployment, restart,
migration, fallback or old-data deletion was performed. The running process must
first use the new implementation through an independently authorized release.

A later authenticated owner Web session can use `bot_package` status and propose
with the registered Folder and relative directory above. Proposal freezes exact
content and presents native owner confirmation. The answer must approve that
specific proposal; this readiness report is not approval. After the wait,
publication validates live purpose, enabled/verified owner state, Project access,
role existence and exclusive assignment again. Busy contexts block publication;
idle contexts for old and new personal connections are retired. Editing source
does not change a frozen proposal. Recompute the revision if source changes.

Both modes share deployment storage, exact-content ask confirmation and optional
Git-backed history. Service mode remains restricted and cannot choose a personal
connection or role; explicit mode is required with no implicit conversion.

## Verification

- Full `pnpm typecheck`: backend/scripts, bridge, desktop and Vue passed.
- Targeted BOT SDK/deployment/guest-runtime, publication, owner pairing/revoke,
  SessionManager personal path and context-preview tests passed.
- Combined targeted run, including service SessionManager isolation and
  custom-role model/prompt checks: **78 tests passed**. The personal test exercises real delivery and ordinary owner tools,
  and denies stranger/group, cross-Project, service-purpose and revoked input.
- Tests use synthetic data in disposable repository-local workspaces. No live
  platform delivery or production deployment was attempted.
