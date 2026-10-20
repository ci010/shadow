---
name: chrome-devtools
description: >
  Browser automation: navigate pages, fill forms, take screenshots, debug
  network requests and console errors, diagnose slow pages and memory issues,
  run audits, and emulate devices; use browser_setup to launch Chrome, Edge,
  or Brave, or attach a compatible Electron CDP target.
metadata:
  core: true
---

# Chrome DevTools MCP — Browser Automation

Use the managed browser through dynamic MCP tools, not shell commands or a
separately launched MCP server. This skill provides task routing and workflows;
the installed server's live schemas are the authority for tool arguments.

For audio recording, microphone levels, camera/video/screen capture, or an
interactive input panel inside Shadow, read `v:skills/io` and use the built-in
I/O panel instead. Do not launch a separate browser or create a standalone
recorder unless the user explicitly wants a separate web application.

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

## Set up a browser instance

Invocation can lazily launch a default browser in an owning session.
Search never launches browsers; use browser_setup to discover live contracts first.
Borrowing leaf calls require the owner to initialize first. To choose a browser,
discover `browser_setup` with `search({ handler: "grep", path: "v:tools", query: "browser_setup" })`,
or invoke the known ID directly:

```js
invoke_tool({ name: "browser_setup", args: { action: "launch", browser: "edge" } })
```

`browser` accepts `edge`, `brave`, `chrome`, or `default`. Alternatively pass
`executablePath` instead of `browser`. An explicit choice never falls back.
Each owned instance exclusively leases one persistent Project browser slot (default 3 total,
across all browser types; tools.chrome.slotCount accepts 1–16). Idle slots rotate.
The first use copies the selected browser's user data; later uses preserve and reuse
the slot copy. A slot is pinned to its executable identity, never shared concurrently.
The original profile is read-only: changes are never synchronized back. Local State
and all standard profiles are copied; the last-used profile is selected (Default
when no last-used selection exists). Close the source browser before first initializing a slot:
locks or copy failures are errors, never a silent blank-profile fallback. If no
user profile exists, a new independent profile is created. Unrecognized custom
executables fail source detection instead of guessing another browser's profile.
Cookies and saved logins may still be unavailable because OS/browser encryption
(including app-bound encryption) is not guaranteed portable to a copy.
Managed launches disable browser sync and extensions and start at `about:blank`
instead of a network new-tab feed. Do not accept browser/vendor account sign-in
or data-import prompts during automation. A managed profile is not an OS-account
sandbox. Explicitly attached targets retain their own profile and lifecycle behavior.
Setup does not change Project configuration.
The managed adapter runs in the effective local session workdir and advertises
that directory as its MCP file root, not the whole Project or another session.
The root stays bound to the instance across tool refreshes and borrowed calls;
close and set up a new instance if the owning workdir changes.
Screenshot/file output paths must stay inside that root; relative paths use
the session workdir. MCP roots are a protocol boundary, not an OS sandbox.

To attach an explicitly preenabled CDP target, including compatible Electron:

```js
invoke_tool({
  name: "browser_setup",
  args: { action: "attach", endpoint: "http://127.0.0.1:9222" }
})
```

Only loopback HTTP(S)/WS(S) endpoints are accepted; a browser WebSocket URL such
as `ws://127.0.0.1:9222/devtools/browser/...` also works. Attach is explicit,
not an import-argument workaround, and does not enable CDP on the target.

Setup returns `{ instance, source: "v:tools/chrome-devtools", mode, owned, ready, ... }`.
Save the opaque `instance` ID. Setup connects and lists live contracts without
business tool RPCs. List or close instances with:

```js
invoke_tool({ name: "browser_setup", args: { action: "list" } })
invoke_tool({ name: "browser_setup", args: { action: "close", instance: "<id>" } })
```

## Discover only the contracts needed now

For a slow page, for example:

```js
search({ handler: "grep", path: "v:tools/chrome-devtools", query: "performance", limit: 3 })
```

With multiple instances, select one explicitly:

```js
search({ handler: "grep", path: "v:tools/chrome-devtools/<id>", query: "snapshot" })
invoke_tool({ name: "chrome-devtools__take_snapshot", instance: "<id>", args: {} })
```

Results contain matching lines and paths. Read
`v:tools/chrome-devtools/<instance>/<encoded-tool-name>` for the exact name,
description, complete JSON Schema and instance ID, then use `invoke_tool`.
Canonical tool names use the `chrome-devtools__` prefix for every instance;
there are no per-instance prefix variants or alternate full source.
`instance` belongs beside `name`/`args`, not inside business tool arguments.
A known exact ID with a known
contract can be invoked directly, including diagnostic tools. No import step
is required. Arguments are validated before execution.

If the desired contract is missing:

1. Check warnings. Global VFS search includes already-loaded browser contracts
   under their instance paths without reconnecting. Uninitialized browser sources
   remain deferred even when explicitly selected. `browser_setup` discovery is metadata only, not
   browser initialization. Installed MCP search remains offline. An empty result
   does not mean the browser lacks the capability.
2. Search `handler: "grep", path: "v:tools/chrome-devtools"` and try a broader regex from the table.
3. If keywords still miss, list that source with
   `search({ handler: "glob", path: "v:tools/chrome-devtools", query: "**", limit: 20 })`.
   Follow the continuation footer's offset only until the needed contract is found or the list ends.
   Do not enumerate every schema before starting ordinary browser work.
4. Report connection/configuration failures separately from unsupported
   capabilities. Only a successful, exhausted listing establishes that
   the tool is not exposed to this session. Do not guess CLI syntax,
   install another server, or bypass the managed browser.

## Observe, act, verify

For page interaction, take a fresh snapshot and use its element identifiers.
After navigation or a state-changing action, observe again to verify the
intended result; a successful tool call alone is not proof.
Use screenshots for visual evidence, not as a substitute for readable controls.

For broken behavior, inspect relevant console messages and network requests,
then fetch details for the failing entries rather than dumping every payload.
For slowness, capture a bounded performance trace around the reproduction,
stop recording, and analyze the relevant insights. Discover each step's
contract when needed. Avoid changing emulation or reloading a stateful page
unless it is necessary for the task.

## Session ownership and delegation

Reading this skill does not start Chrome. Targeted tool discovery, invocation,
or preload may auto-detect and launch Chrome/Edge/Brave with a managed debugging
port. Loading tools does not inject all their schemas into the base tool list;
search results, snapshots, and logs still consume conversation context.

One session instance allows omitted `instance`; two or more require an explicit
ID. There is no mutable current browser. IDs are scoped to the session lifecycle:
invalid or other-session IDs fail without fallback. Each instance has an isolated
tool registry. Sleep/reset closes owned instances; attached targets are only
disconnected, never killed. Sign in separately in fresh owned profiles if needed.

Keep simple tasks in the current session. Delegate bounded, complex investigations
to isolate their snapshots/logs, or independent tasks for parallel browsing,
not merely to hide tool schemas. Separate ordinary tasks/sessions are independent:
an ordinary task does not inherit the parent's open page or login. Blocking leaf
calls/snapshots instead borrow the owner's instance IDs: they may interact/list
but cannot launch, attach, or close them. If the owner has no browser, automatic
discovery/invocation fails asking the owner to initialize first; it never silently
creates a persistent resource in a leaf.

Optional `preload_tools: { "chrome-devtools": [] }` still works and starts discovery
early; omit it when lazy discovery is sufficient. Startup import/preload arguments
are pinned per instance; changing them cannot silently create a second browser.
Use `browser_setup` for explicit setup, not raw endpoint/profile/executable flags.
Do not manually allocate ports.

## Setup failures

Report the returned failure rather than falling back to another browser.
For a missing executable, use an approved installed browser or explicit
`executablePath` through `browser_setup`, or ask the user. Occupied launch ports
are rejected, never implicitly attached. Explicit attach requires a preenabled
CDP endpoint.
Read `references/mcp-args.md` only for managed startup/configuration problems;
it is not an alternative browser-operation CLI. The built-in catalog entry
already exists: do not replace it with external MCP configuration.
Browser/host tests are synthetic, not actual browser end-to-end verification.

### Slot capacity and recovery

When all slots are busy, incompatible, or quarantined, launch fails explicitly; it
does not evict another instance or erase its data. Close an owned instance or use
a compatible browser. Attach uses no slot and does not change target lifecycle.
Release returns a slot only after the owned PID is confirmed exited. Unknown
startup/cancellation outcomes and failed stops keep slots unavailable.
Persistent lease directories are not automatically stolen on restart, even if an
owner PID appears dead: descendants/PID reuse make that insufficient proof. Never
automatically kill old processes. An operator must stop managers, verify no browser
uses the slot, then clear stale lease/browser lock remnants. A stale allocation.lock
also requires stopped managers before removal. Profiles and old UUID directories
are retained; no automatic migration, deletion, or source write-back occurs.
The persisted pool cap must match slotCount; changing an initialized cap requires
an explicit offline migration preserving existing slot metadata/data.
