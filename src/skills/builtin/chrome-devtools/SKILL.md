---
name: chrome-devtools
description: >
  Browser automation: navigate pages, forms, screenshots, network, console,
  slow pages, memory, audits and emulate devices; browser_setup guides connection
  to human-owned Chrome or preenabled Edge/Brave/Electron; never launches browsers.
metadata:
  core: true
---

# Chrome DevTools MCP — User-owned browser connections

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

## Choose the human browser first

Discover setup with `search({ handler: "grep", path: "v:tools", query: "browser_setup" })`.
Read its contract, then invoke:

```
invoke_tool({ name: "browser_setup", args: { action: "discover" } })
```

Discovery returns connection guidance, not an inventory of profiles. Ask the user
which running browser and human profile Shadow should share, using the existing
conversation input/decision mechanism. Do not inspect real profiles or infer
permission from a filesystem path. Explain that CDP access is browser-wide,
not isolated to the selected human profile; other tabs/profiles exposed by that
browser may be accessible. A pageId routes a page, not a permission boundary.

Recommended: in Chrome 144+, the user enables debugging themselves at
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
that restriction: do not enable debugging, restart/kill the user's browser, copy
profiles, or launch a second process sharing its user-data-dir. No silent launch
or private-profile fallback exists. If unavailable, ask the user to configure a
supported connection themselves. Setup does not change Project configuration.

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
other-session IDs fail without fallback. Sessions can bind the same user browser:
they share browser state, cookies, tabs and human changes. No claim of tab
ownership or browser isolation is made. Leaf calls borrow their owner's binding
and may interact/list, but cannot connect/close. A new independent session has no
binding; it does not inherit the parent's open page or login by default.

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
