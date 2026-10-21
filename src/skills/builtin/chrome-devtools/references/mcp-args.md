# Chrome DevTools MCP — Connection contract

Browser actions use discovered tools, not shell-launched adapters. The built-in
adapter is pinned to `chrome-devtools-mcp@1.10.1`; upgrading requires reviewing
routing, schemas and disconnect behavior. This is not a promise about arbitrary
custom MCP servers or host commands.

## User-owned connections

Start with browser_setup discover. Ask which running browser and human profile
to share, and explain browser-wide CDP access (not profile isolation).

- Chrome 144+: the user enables remote debugging at
  `chrome://inspect/#remote-debugging` and approves the Chrome connection prompt.
  Bind `autoConnect` with explicitly chosen stable/beta/dev/canary channel.
  Optional absolute `userDataDir` is a user-identified data root, not a profile
  selector. Auto-connect reads DevToolsActivePort; it does not launch Chrome.
- Alternatively attach an already-enabled loopback HTTP(S) origin or browser
  WebSocket endpoint, including compatible Edge/Brave/Electron. Examples:
  `http://127.0.0.1:9222`, `ws://127.0.0.1:9222/devtools/browser/...`.
- Chrome 136+ ignores command-line remote-debugging-port/pipe for its default
  data directory. Do not bypass this with profile copies, another process sharing
  the directory, or an agent-initiated restart. Do not scan ports or enable debugging.

Setup loads MCP contracts without browser business RPCs. `ready` means adapter
ready, not verified browser/profile identity. On first browser operation Chrome
may ask the user to authorize access. Use list_pages to check the intended target.
If incorrect, disconnect and ask the user, never silently switch browsers.

Bindings last until close/sleep/reset and are inspectable with setup list. These
operations disconnect MCP only; the browser stays user-owned. Reconnect using the
same still-approved choice without repeating OS setup unless needed; reconfirm
changed scope/target. No global browser permission or sensitive binding is saved.
Leaf calls borrow bindings but cannot connect or disconnect them.

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

The former slot pool and launch/profile-copy mechanism are removed. Old user data,
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

Other lifecycle tests mock MCP connections. No tests here verify actual Chrome
consent UI, OS-specific channel discovery, browser-wide profile visibility or live
CDP behavior. App handoff failures preserve the shared binding; only a positively
identified new page is eligible for cleanup under the caller's close_page permission.
Unknown page creation outcomes are left for inspection, never resolved by disconnecting
or closing unrelated pages.
