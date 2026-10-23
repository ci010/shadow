# Chrome DevTools MCP — Connection contract

Browser actions use discovered tools, not shell-launched adapters. The built-in
adapter is pinned to `chrome-devtools-mcp@1.10.1`; upgrading requires reviewing
routing, schemas and disconnect behavior. This is not a promise about arbitrary
custom MCP servers or host commands.

## Project-managed copied profile (default)

Start with browser_setup discover. Ask for an explicit absolute Chrome executable,
source user data root and Default/Profile N directory, and confirm copying plus
browser-wide sharing by permitted sessions in this Project. Only recognized Chrome
installation paths are accepted, not arbitrary executable programs. action managed makes
an opaque selected-profile + Local State copy and launches only that independent
copy. It does not parse credentials, modify the source, infer last-used profiles,
fall back to a blank profile or overwrite old copies. Missing/locked/unsupported
sources fail. Have the user close a locked source; never kill it or remove locks.
Encrypted credentials and live databases may not transfer; login is not promised.

One SharedChrome manager belongs to each Project runtime (not a global pool or
session slot). Concurrent setup is deduplicated; every session explicitly binds
and has an isolated MCP registry. Manager launch uses a unique private directory,
--remote-debugging-address=127.0.0.1 and --remote-debugging-port=0, reads only the
managed DevToolsActivePort, and passes a validated loopback WebSocket endpoint to
the pinned adapter. Sync/extensions are disabled. No port scanning or source CDP
attachment occurs. Browser state is shared, permissions are not; coordinate pages.

Session close/sleep/reset only disconnects MCP. Project shutdown stops only the
manager's retained child handle. A confirmed child exit permits relaunch against
the same copy, never destructive recopy. A new Project runtime creates a unique
copy; old copies remain for user-controlled cleanup. A different source/executable
cannot replace an initialized choice. A live but unusable child is not replaced
with another process. Local CDP is not authenticated; protect host access.

## Explicit compatibility connections

Only when explicitly requested, autoConnect connects human-owned Chrome 144+
with user-enabled debugging at chrome://inspect/#remote-debugging and approval
of Chrome's prompt. Supply the chosen stable/beta/dev/canary channel and optional
absolute root. This reads DevToolsActivePort, not a profile isolation selector.
Alternatively attach an already-enabled loopback HTTP(S) origin or browser WS(S)
endpoint, including compatible Edge/Brave/Electron. Do not scan ports or enable
debugging yourself. Chrome 136+ rejects debugging flags against its default root;
never launch against that root or bypass its locks. No silent fallback from
managed copying to human-owned attachment is allowed.

Setup loads MCP contracts without browser business RPCs. ready means adapter-ready,
not verified profile/login identity. Use list_pages to verify the target first.
Bindings are session-only; reconnect explicitly with the still-approved choice.
Reconfirm changed scope/target. Leaf calls borrow but cannot connect/disconnect.
## Routing and imports

Every page tool requires an explicit integer pageId. select_page is hidden and
rejected; incompatible schemas fail closed, with no implicit selection fallback.
list_pages, new_page and offline heap-analysis tools are browser-independent of
a preexisting pageId. Tool registry isolation does not isolate browser state.

Import/preload arguments and `.chrome-devtools.json` accept only these boolean
capability/telemetry flags: `--usage-statistics`, `--performance-crux`,
`--category-emulation`, `--category-performance`, `--category-network`.
Camel-case aliases and `--no-` variants are accepted; values may use `=true` or
`=false`. All connection, port, executable, profile, slim and routing flags are
rejected; use browser_setup for explicit connection binding. Startup arguments
are fixed per binding. Empty Chrome preloads require an existing owner binding.

## Migration and recovery

The former per-session slot pool is not restored. Old user data,
profiles and leases are not deleted or migrated and old processes are not killed.
Remove obsolete `tools.chrome` fields (only an empty compatibility object remains),
and remove obsolete port/launch/profile flags from adapter configuration/preloads.
Configuration errors fail explicitly, not by falling back to a fresh browser.

Use structured MCP failure diagnostics. An incompatible tool schema requires a
compatibility review, not disabling page routing or using slim. Do not silently
change disabled categories or telemetry settings. Generic MCP configuration is a
separate task covered by `v:skills/mcp-config`.

## Evidence and limits

- Reviewed installed 1.10.1: `build/src/config/mcp-options.js` (pageIdRouting)
  and page-tool definitions/ToolHandler (explicit pageId). Shadow validates live
  schemas in addition to pinning.
- In that release, `build/src/BrowserManager.js:172-179` returns `#connect()`
  when autoConnect is true; only the alternative branch launches. Lines 268-345
  read a supplied data root's `DevToolsActivePort`, construct a loopback endpoint,
  and call puppeteer.connect. Read/connection failures throw, without a launch
  fallback. Lines 346-363 disconnect connected browsers instead of closing them.
- `build/src/index.js:115-119` registers schemas from createTools during init;
  browser acquisition is deferred to getContext at lines 155-156, used by tool
  handlers. initialize/tools/list alone therefore does not acquire a browser.
- Upstream connection guide: https://github.com/ChromeDevTools/chrome-devtools-mcp#connecting-to-a-running-chrome-instance
- Chrome default-directory change: https://developer.chrome.com/blog/remote-debugging-port

`src/browser/chrome-package_test.ts` is an opt-in offline compatibility test:
set `SHADOW_CHROME_MCP_PACKAGE_DIR` to an already installed 1.10.1 package root.
It verifies the package version and starts its Node adapter explicitly configured
for loopback port 1, with telemetry disabled; only initialize/tools/list execute.
The full default set (30 upstream tools, 29 exposed) and all eight combinations of
the supported emulation/performance/network category switches are checked. A second
test exercises the actual BrowserManager with synthetic DevToolsActivePort data
and mocked Puppeteer connect/launch, proving failure does not fall back to launch.
Without the environment variable these tests explicitly skip, never download.

Lifecycle/copy tests use synthetic profile files and injected process/MCP boundaries.
No tests here verify actual Chrome launch, login inheritance, encryption portability,
consent UI, OS-specific channel discovery, browser-wide profile visibility or live
CDP behavior. App handoff failures preserve the shared binding; only a positively
identified new page is eligible for cleanup under the caller's close_page permission.
Unknown page creation outcomes are left for inspection, never resolved by disconnecting
or closing unrelated pages.
