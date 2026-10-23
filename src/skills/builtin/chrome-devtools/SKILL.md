---
name: chrome-devtools
description: >
  Browser automation: navigate pages, forms, screenshots, network, console,
  slow pages, memory, audits and emulate devices; browser_setup guides connection
  to Project-shared copied-profile Chrome; explicit attach for Edge/Brave/Electron.
metadata:
  core: true
---

# Chrome DevTools MCP — Project-shared copied-profile Chrome

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

## Choose the source profile explicitly

Discover setup with `search({ handler: "grep", path: "v:tools", query: "browser_setup" })`.
Read its contract, then invoke:

```
invoke_tool({ name: "browser_setup", args: { action: "discover" } })
```

Discovery returns guidance, not an inventory of profiles. The default is an
application-managed Chrome with a separate COPY of the user's chosen profile.
Managed launch accepts recognized Chrome installation paths only (standard Windows,
macOS and Linux locations/channels), not custom executable programs. Use explicitly
approved attach for other installations or browsers.
Ask for the absolute Chrome executable, user data ROOT and profile directory
(`Default` or `Profile N`, visible at chrome://version). Confirm copying that
profile and sharing its managed browser with all permitted sessions in this
Project. Do not inspect credentials, infer a profile from last-used state, or
launch against the original directory. Use the existing conversation input/decision
flow for missing input and authorization.

```
invoke_tool({ name: "browser_setup", args: { action: "managed", executablePath: "<absolute Chrome executable>", userDataDir: "<absolute source data root>", profileDirectory: "Default" } })
```

The manager copies only the selected profile and opaque Local State into a unique
Project-owned directory, disables sync/extensions and starts one loopback-CDP
Chrome per Project runtime. All explicitly bound sessions share this process,
cookies and tabs, but retain independent tool registries and permissions. Other
Projects are isolated. Source files are never modified or written back; no
existing copy is overwritten. If the source is locked, ask the user to close it
before retrying; never remove its locks. Encrypted cookies/passwords and active
databases may not transfer reliably. Re-login in the managed browser may be
required. Do not claim inherited login before verifying in a page.

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

Setup loads adapter contracts; `ready` means adapter-ready, not proof of browser
connection or human profile identity. The adapter establishes CDP on the first
browser operation. List pages and verify the intended target before acting. If
wrong, disconnect and ask the user, rather than choosing another browser silently.

```
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
