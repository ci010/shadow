> **WIP design/workstream reference.**
> Workspaces, Nodes, and Approvals screens are fixture-backed; visible routes
> and role policies are not evidence of live device administration. Approval
> decisions are not yet connected in this UI. See the
> [status/index](README.md) and [current architecture](../architecture.md).

# S6: Frontend Product UI

> Owner: frontend
>
> Depends on: S0; mock-first, then S1/S3/S5

## Goal

Evolve the current diagnostics-oriented Vue UI into one role- and scope-aware
product UI while preserving the chat/session functionality already present.

## Owned Modules

- `app/src/App.vue`
- `app/src/router.ts`
- `app/src/components/ChatTab.vue`
- new workspace/knowledge/nodes/settings/diagnostics views
- installation-context and API client composables

Do not add Electron imports to Vue components. Native operations go through a
typed preload-facing service injected at application startup.

## Information Architecture

- Chat
- Workspaces
- Knowledge
- Automations
- Nodes
- Settings
- Diagnostics, containing current Agents, Spans, and Logs

Visibility and mutation controls use `uiScopes`. Installation mode controls local
surfaces such as This Machine and Approvals, not remote Main admin rights.

## Required Persistent Status

- Main or Child runtime role;
- Main connection state and latency;
- active session node/workdir and availability;
- pending local approvals;
- agent/model health where authorized.

Move the global model selector out of the primary application bar. A model change
is a settings/session action, while locality and connectivity affect every tool.

## Session Locality UX

- Session header displays node, workdir capability, and online state.
- Workdir picker groups capabilities by node and permission.
- Changing workdir states that future calls are affected.
- Offline/revoked workdir remains selected and visibly unavailable.
- UI never silently selects another node.
- File browser distinguishes project workdir from Main-owned session artifacts.

## Node and Approval UX

Nodes view includes pending pairing, online state, version, capabilities, last
seen, audit summary, and revoke action.

Child local approvals show:

- requesting agent/session;
- operation and structured summary;
- node/workdir scope;
- expiry;
- Allow once, Allow for session, and Deny.

Do not make permanent broad access the primary action. An admin Main user cannot
remotely click through a Child-local approval.

## Multi-Client Behavior

- Session/config mutations send revision or idempotency values.
- Conflict responses prompt refresh/reapply instead of overwriting silently.
- SSE events carry session IDs and cursors; an event for an inactive session does
  not append to the active conversation.
- Connection restoration reconciles server state before replaying optimistic UI.

## Mock Contract Fixtures

Frontend work can begin before S3 by maintaining fixtures for:

- desktop-hosted Main admin;
- headless Main admin through Child;
- restricted Child;
- Main offline;
- selected workdir offline/revoked;
- pending local approval;
- protocol update required.

## Tests

1. Route/nav matrix for mode plus UI scopes.
2. Admin Child can edit Main settings; restricted Child cannot.
3. Local capability grants appear only on the owning Child.
4. Session locality remains visible at desktop and mobile widths.
5. Out-of-order SSE does not contaminate another session.
6. Offline/reconnect and revision conflicts preserve user input safely.
7. Long node/path/agent labels do not overlap or resize fixed controls.
8. Playwright screenshots cover wizard handoff, chat, nodes, approvals, and offline
   states.

## Exit Criteria

- One Vue build serves every topology.
- Product navigation is usable without exposing diagnostic detail by default.
- Role/scope checks are enforced server-side too; UI hiding is not authorization.
