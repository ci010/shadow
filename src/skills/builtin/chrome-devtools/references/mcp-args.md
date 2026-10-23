# Chrome DevTools MCP — Connection contract

Browser actions use discovered tools, not shell-launched adapters. The built-in
adapter is pinned to `chrome-devtools-mcp@1.10.1`; upgrading requires reviewing
routing, schemas and disconnect behavior. This is not a promise about arbitrary
custom MCP servers or host commands.

## Project-managed copied profile (default)

Start with browser_setup discover: installed supported browsers, stable installation IDs,
standard source roots, minimal profile directory/display names, existing shared choice.
The agent/tool discovers paths; never ask users for executable/root paths. Use managed
with installation (e.g. edge:stable) or browser, and optional profile display name or
directory. A sole candidate is automatic; honor the user's named profile and ask only
for ambiguous choices. No Default/last_used guessing. Reuse an existing Project choice
with managed and no selectors, without copying or asking again. Confirm copying and
browser-wide Project sharing. Legacy explicit path overrides remain validated, not the
normal workflow. Only reviewed matching brand/channel executable/root pairs are accepted.
Discovery reads bounded Local State profile labels only; it does not output account
metadata or email-like labels, read cookies/history/credentials, copy or launch.
Windows/macOS: Chrome and Edge stable/beta/dev/canary, Brave stable/beta/nightly,
Chromium standard install. Linux: Chrome and Edge stable/beta/dev, Brave
stable/beta/nightly, Chromium native package paths. Portable/custom roots,
Snap/Flatpak and other CDP applications require explicit attach. Add managed
support only by reviewing installation/profile pairs, Chromium flags and copy
compatibility in managed-browsers.ts; do not relax validation to a basename or
agent-provided executable allowlist. Paths are canonicalized, not binary-attested;
host installation integrity is an OS trust boundary. action managed makes
a private independent key-data copy; it never modifies the source or overwrites old copies.
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
