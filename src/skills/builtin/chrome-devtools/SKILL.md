---
name: chrome-devtools
description: >
  Browser automation: navigate pages, forms, screenshots, network, console,
  slow pages, memory, audits and emulate devices; browser_setup guides connection
  to Project-shared copied-profile Chrome/Edge/Brave/Chromium; explicit CDP attach for Electron and custom layouts.
metadata:
  core: true
---

# Chromium CDP automation — Project-shared copied profiles

Read this skill, then use dynamic MCP tools, not shell-launched adapters.
For recordings, microphone, camera and interactive input panels use `v:skills/io`,
unless the user explicitly wants a separate web application. Do not build a
standalone recorder merely to collect missing task input.

## Route the task before searching

One source, `v:tools/chrome-devtools`, covers interactions, diagnostics, and
emulation. Choose search keywords by task, not just by tool names:

| Task or symptom | Useful query |
|---|---|
| Open a URL, read/scrape a page, inspect controls | `navigate`, `snapshot` |
| Click, fill a form, upload a file, capture appearance | `click`, `fill`, `upload`, `screenshot` |
| Failed API request, missing response, loading failure | `network` |
| Broken button, JavaScript error, unexpected behavior | `console` |
| Slow page, rendering delay, performance trace | `performance` |
| Growing memory usage or a suspected leak | `memory` |
| Mobile layout, viewport, device/network emulation | `emulate`, `resize` |
| Page quality or accessibility audit | `lighthouse` |

Use short English keywords from this table even when the task is in another
language: tool search uses case-sensitive regular expressions, not semantic matching. These are routing hints, not a
fixed inventory or a guarantee that every installed version has every feature.

## Connect first; choose a source only when needed

The everyday entry is `browser_setup` with `action: "connect"` (optional `instance`).
It reuses this session's binding, otherwise binds the approved Project managed choice,
and restores that same managed copy after a crash. Success returns `status: "connected"`,
`ready: true`, actual `list_pages`, source and usage. MCP initialization alone is only
`adapterReady`, not proof of CDP access. A failed page-list probe must not be described
as connected. Multiple bindings require an explicit instance; never silently pick one.
Reusing a binding grants no extra tool authority. Sessions share browser-wide pages,
not owned tabs. No automatic fallback to a human browser is permitted.

With no binding or approved choice, connect returns `needs-selection` and discovery
candidates without copying or launching. Even one candidate does not authorize copying.
After approved initial `managed` setup (or explicitly approved compatibility setup),
call connect to verify the real browser connection.

## Choose the source profile explicitly

Discover setup with `search({ handler: "grep", path: "v:tools", query: "browser_setup" })`.
Read its contract, then invoke:

```
invoke_tool({ name: "browser_setup", args: { action: "connect" } })
```

For inventory-only inspection without connection or copying, use explicit discover:

```
invoke_tool({ name: "browser_setup", args: { action: "discover" } })
```

Discovery returns installed supported browsers, stable installation IDs, matching source roots,
and profile candidates (directory identifier and display name only), plus the existing
Project shared choice. It never launches/copies or reads cookies/history/credentials.
The agent/tool discovers paths: do not ask the user for executable or root paths.
Reuse an existing Project choice first (connect with no selectors). Otherwise choose
the user's browser/installation and match their stated profile name. Unique candidates
are selected automatically. Ask which profile name only when multiple candidates are
ambiguous; never silently choose Default or last-used. If multiple browsers are installed,
use the user's stated brand or clarify that choice. Confirm copying and browser-wide
sharing by permitted Project sessions, without repeatedly asking for known choices.
Standard Chrome, Edge, Brave and Chromium brand/channel pairs are validated on
Windows/macOS/Linux. Never cross-import another browser/channel profile. Custom,
portable, Snap/Flatpak or other CDP apps require explicitly approved attach.

```
invoke_tool({ name: "browser_setup", args: { action: "managed", installation: "edge:stable" } })
// With ambiguous profiles, after the user selects a discovered label:
invoke_tool({ name: "browser_setup", args: { action: "managed", installation: "edge:stable", profile: "Work" } })
```

Copies only key data from the selected profile: Cookies, Login Data, Web Data,
Preferences, Secure Preferences (and SQLite sidecars), Local Storage, Session Storage,
IndexedDB, Network, plus root Local State. History, other profiles, caches and runtime
locks are omitted. Source files are read-only; never remove locks, bypass OS locks,
or require the user to close their browser. Each source read/copy failure (including
Local State and changed files) skips only that item with a structured warning: stage,
source-relative item, safe code and OS code, never file contents/native error text.
Optional missing items appear in absent, not warning floods. browser_setup returns
copyReport with ready/ready_with_warnings, copiedFiles, absent, warnings, loginData and
message. Relay warnings to the user: missing data may require signing in again. Even
if all key data fails, launch the usable copy and clearly state no login data migrated;
never claim complete login inheritance. Invalid source roots/boundaries, destination
infrastructure failures, cancellation, invalid executables and shared-choice conflicts
remain blocking. Linked/unsupported individual entries are skipped with warnings, never
followed. Metadata checks are not atomic snapshots; encrypted credentials may not transfer.
The original initialization report survives cross-session reuse and crash restart;
reuse does not refresh/copy again.

One managed browser per Project runtime uses a unique private copy with sync/extensions
disabled and loopback CDP. Sessions share browser state but retain independent registries
and permissions. Never overwrite an existing copy.

The Project manager stops only its own child at Project shutdown. Session
close/sleep/reset only disconnects that session. Crash recovery reuses the same
copy with the same explicit choice; changing the source within that runtime is
rejected once copied. A new runtime creates a fresh unique copy; old copies are
retained as sensitive data for user-controlled cleanup, not deleted automatically.
Coordinate edits: pageId is routing, not tab ownership or a permission boundary.

### Explicit compatibility connections (not the default)

Only if the user explicitly wants to share their original running browser,
explain browser-wide CDP access, not isolated to the selected human profile;
other profiles/tabs may be exposed. Never silently fall back to this mode.

In Chrome 144+, the user enables debugging themselves at
`chrome://inspect/#remote-debugging` and approves Chrome's connection prompt.
Then use their explicitly selected installation channel:

```
invoke_tool({ name: "browser_setup", args: { action: "autoConnect", channel: "stable" } })
```

Channels: stable, beta, dev, canary. A nonstandard data root may be supplied as
`userDataDir` with autoConnect, only after the user identifies it (Profile Path's
parent at chrome://version). This reads an existing DevToolsActivePort; a path
alone does not make an unconfigured browser attachable. It is not a profile
selector and does not restrict access to Default/Profile 1.

For an already-enabled loopback HTTP(S)/WS(S) CDP target, including compatible
Edge, Brave or Electron:

```
invoke_tool({ name: "browser_setup", args: { action: "attach", endpoint: "http://127.0.0.1:9222" } })
```

Browser WebSocket endpoints such as `ws://127.0.0.1:9222/devtools/browser/...`
are also supported. Never scan ports to guess a target. Chrome 136+ ignores
command-line remote-debugging-port/pipe on its default data directory. Respect
that restriction: never launch against the original data directory, enable debugging
on it, or restart/kill the user browser. Managed launch is only against its separate
explicitly authorized copy. Setup does not change Project MCP configuration.

## Address pages explicitly

Lower-level managed/attach/autoConnect setup loads adapter contracts only:
`adapterReady` means MCP initialization. `ready` records a successful connect
`list_pages` probe, not continuous liveness or verified human profile identity.
Use the pages returned by connect to verify the intended target before acting;
no duplicate list_pages is needed immediately after successful connect. Request a
fresh list when page state may have changed or after lower-level setup without connect.
If wrong, disconnect and ask the user, rather than choosing another browser silently.

```
// Only when a fresh page list is needed (connect already returns one):
invoke_tool({ name: "chrome-devtools__list_pages", instance: "<id>", args: {} })
invoke_tool({ name: "chrome-devtools__take_snapshot", instance: "<id>", args: { pageId: 1 } })
```

Every page-scoped tool requires pageId. `select_page` is not exposed or callable.
Missing/invalid IDs fail; no fallback to a selected page. Do not reuse node UIDs
across pages. `list_pages`, `new_page` and offline heap-analysis tools are not
page-scoped. The adapter release is pinned and disables implicit-selection/slim
configurations; upgrades require compatibility review.

Each binding has a session ID and isolated tool registry, not a private browser.
One binding allows omitted `instance`; two or more require it. Invalid and
other-session IDs fail without fallback. Sessions bind the same Project-managed browser by default:
they share browser state, cookies, tabs and human changes. No claim of tab
ownership or browser isolation is made. Leaf calls borrow their owner's binding
and may interact/list, but cannot connect/close. A new independent session has no
binding; it does not inherit the parent's open page or login until explicitly bound
to the shared Project choice. This shares browser state, not tool authority.

```
invoke_tool({ name: "browser_setup", args: { action: "list" } })
invoke_tool({ name: "browser_setup", args: { action: "close", instance: "<id>" } })
```

Binding choices are intentionally session-only: list retains them until
close/sleep/reset; afterwards reconnect explicitly using the previously approved choice if still applicable; do not repeat OS setup unless Chrome requests it. Reconfirm if the target or access scope changes. Sleep/reset/close only
disconnect MCP and forget bindings, never kill the user browser. Failed imports
also disconnect. Startup import/preload arguments are fixed per binding and
allow only reviewed telemetry/capability flags. Raw endpoint/profile/executable,
port, slim and routing switches are rejected. Empty preloads require an existing
binding; they cannot auto-launch or auto-connect.

## Discover only the contracts needed

Global VFS search includes already-loaded contracts without reconnecting;
uninitialized browser sources remain deferred. Installed MCP search is offline.

```
search({ handler: "grep", path: "v:tools/chrome-devtools/<id>", query: "snapshot" })
search({ handler: "glob", path: "v:tools/chrome-devtools", query: "**", limit: 20 })
```

Read returned paths for full schemas. Check warnings: partial search results do
not prove absence. Broaden the regex and follow the continuation footer's offset.
Delegate for an independent task, not merely to hide tool schemas.
Browser tests are synthetic, not actual browser end-to-end verification.
Connection evidence, version boundary and migration: [MCP arguments](references/mcp-args.md).
