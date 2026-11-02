# BOT frontmatter migration — source ready, deployment pending

Recorded 2026-11-01. This report does **not** claim live deployment.

## Discovery and boundaries

- Running task host: Electron Helper PID 89875, parent Electron PID 89871.
  `exec` parent PID and filtered `lsof` evidence identify this host, not a guessed instance.
- Host data root `/Users/honx/.shadow` was derived from host-provided
  `SHADOW_SESSION_DATA_DIR=/Users/honx/.shadow/projects/default/workdirs/virtual_general-e6879534273d4280`,
  checked against `src/projects/contracts.ts` / `src/utils/data-paths.ts` and the
  existing `projects.json` catalog. Host open-file paths corroborated Default and
  XMCL Project state directories. No credential/config-secret files were read.
- Current marked deployment inventory: Default 1, XMCL 2. Inactive legacy
  `bots/deployments/` was not adopted. The user clarified the earlier count of four.
- XMCL Project ID: `c35b5685-86ab-4759-9ec8-0fbc039c5bbb`.
- Each source matched its active frozen revision **before** edits. No unrelated
  unpublished source changes were included. No private deployment storage,
  connection, ownership, grants, tools, mutable data or active hashes were written.
- No commit, push, sync or restart was performed by this task. Parent coordinates
  backend activation and each owning Project's ordinary authenticated owner Web
  deployment confirmation. A temporary task cannot publish; Default tools cannot
  impersonate XMCL scope.

## Source changes

`BOT.md` now owns `id`, `config`, `mode`, Service inference overrides or Personal
`agent`. JSON retains connection, subscriptions, permissions, tools, skills and
read scopes. Whole legacy packages remain readable; mixed/duplicate fields fail.

All three real sources pass the new strict parser. Only `BOT.md` and `bot.json`
changed; prompt bodies and tool module bytes are identical. Both Service packages
had no explicit inference overrides, so none were invented. Their model inheritance
is unchanged. Personal `agent: general` and connection identity are unchanged.

The QQ issue package additionally had an invalid retired `bindings[0].skills`
selector. Under the separately approved cleanup decision, only that selector was
removed. Its top-level skill prompt, grants, tool exposure, read folders and
subscription/trigger declarations remain identical. Publishing this repair will
restore validity under the current schema, not merely change formatting. The
normal proposal question explicitly discloses invalid-state recovery and all
candidate permissions; arbitrary invalid packages still fail closed.

## Package results and exact proposals

Read `bot_package {"action":"status"}` in the owning Project **again** before
proposing. If either active or source hashes changed, stop and review rather than
reuse these values blindly. Below are proposed tool arguments, not executed calls.

### Default / shadow

- Project: `default`
- Source migrated: yes, `/Users/honx/Workspaces/shadow/bot-packages/new-format/shadow`
- Deployed migrated: **no**
- Active before **and after**: `d1d16d0459b3d90a57fb56c76f33f528c446597aa86210767a32a9dba5b5fba9`
- Candidate/source after: `66878ff84e17f35476ae550a6d396951e0beefa9521f30bfd9caacda3f9ccb4c`
- Before had no previous slot. A successful proposal must retain the above active
  revision as previous.

```json
{
  "action": "propose",
  "folderId": "991eee02-ea7b-40d4-b76f-3f31fa7dc3b0",
  "directory": "bot-packages/new-format/shadow",
  "expectedRevision": "d1d16d0459b3d90a57fb56c76f33f528c446597aa86210767a32a9dba5b5fba9",
  "summary": "仅将 mode 和 Personal agent 搬到 BOT.md frontmatter；身份、connection、owner、工具和模型角色语义不变。"
}
```

### XMCL / xmcl-discord-support

- Source migrated: yes, `/Users/honx/Workspaces/xmcl-bots/new-format/xmcl-discord-support`
- Deployed migrated: **no**
- Active before **and after**: `b8cd4aa378ed9bacbfdb4a94362f5324d8846626363fcda4953e6068d4e5fac7`
- Candidate/source after: `aec10c87f3ead42c62068c6ca47019d028c7ff6786497f1b2aca27f941636e56`
- Existing previous verified: `2cdfac8121a43c6343e0b7d1625f1cf30a1e36a240afc035a7c1e51899cd032f`

```json
{
  "action": "propose",
  "folderId": "8e32818a-c76d-4808-8e8d-06b2fd831866",
  "directory": "new-format/xmcl-discord-support",
  "expectedRevision": "b8cd4aa378ed9bacbfdb4a94362f5324d8846626363fcda4953e6068d4e5fac7",
  "summary": "仅将 mode 搬到 BOT.md frontmatter；Discord身份、bindings、grants、tools、订阅、提示词及模型继承完全不变。"
}
```

### XMCL / xmcl-issue-assistant

- Source migrated: yes, `/Users/honx/Workspaces/xmcl-bots/new-format/xmcl-issue-assistant`
- Deployed migrated: **no**
- Active before **and after**: `beeca237200589fa5ca5babef700f2941ae673c3b80f16c3ef4b2d8f0bfa9320`
- Candidate/source after: `56a44944183a5aa51801abb7530921ecb475592caf4e897bfd6e70652a19a629`
- Existing previous verified: `657cb5acf8640fc16725f2d5ddb8b97f50f8ed743052931b2a708033d3de0abd`
- Independent repair: remove invalid legacy binding skill selector, preserve
  top-level `xmcl-issues` prompt. This must remain explicit in owner confirmation.

```json
{
  "action": "propose",
  "folderId": "8e32818a-c76d-4808-8e8d-06b2fd831866",
  "directory": "new-format/xmcl-issue-assistant",
  "expectedRevision": "beeca237200589fa5ca5babef700f2941ae673c3b80f16c3ef4b2d8f0bfa9320",
  "summary": "将 mode 搬到 BOT.md，并按已批准修复删除无效 bindings[0].skills；顶层 skill 提示词及所有声明权限不变。旧包当前 schema 无效，本次部署会恢复有效订阅/运行，仍须确认完整候选权限。"
}
```

## Backups and recovery

Complete original source backups are outside the proposed package directories:

- Default: `/Users/honx/Workspaces/shadow/bot-packages/format-backups/2026-11-01T11-05-17-115Z/shadow`
- XMCL: `/Users/honx/Workspaces/xmcl-bots/format-backups/2026-11-01T11-05-17-115Z/xmcl-discord-support`
- XMCL: `/Users/honx/Workspaces/xmcl-bots/format-backups/2026-11-01T11-05-17-115Z/xmcl-issue-assistant`

Each backup was re-frozen and verified against its active-before hash. Backup
creation used private directory/file modes and exclusive filenames. Restore source
only after checking no new user changes; do not copy backups into a package or
manually edit deployment slots. The old issue package backup intentionally retains
the known invalid selector. No live recovery or rollback was run.

Current and existing previous slot hashes were verified; no promotion journal or
lock existed at investigation. Disposable tests cover exact frozen approval,
previous retention, cancellation, stale revision, live permission revalidation and
restorePrevious. These do not prove filesystem/power-loss durability or live
platform delivery. Normal publication may still fail on busy contexts or changed
live authority; it must not bypass those gates.

## Verification

- Backend `pnpm exec tsc --noEmit`: passed.
- BOT, input-routing, mode, personal and guidance test selection: 102 passed after
  adding the narrow proposal-repair coverage.
- Focused Discord SDK test: passed using the actual SessionManager/adapter path
  with synthetic provider and transport; all five Service inference overrides
  reached provider requests. QQ/Feishu tests cover JSONL and SQLite stores.
- New/old parser, mode separation, mixed/duplicate rejection, custom config path,
  CRLF prompt preservation, immutable conversion and no field/default invention:
  passed.
- Own-source `git diff --check`: passed. Global diff check reports pre-existing
  whitespace in unrelated work-organizer edits; those files were not modified.
- Live platform calls, owner deployment approvals and backend restart: not run by
  this task. This report's candidate revisions are **not deployed revisions**.
