# Chrome DevTools MCP — Managed Startup Options

Read this only when diagnosing startup/configuration failures. Browser actions
use `search` and `invoke_tool`, not a CLI. Live tool schemas, not startup flags,
define the available actions and arguments.

## Explicit session setup

Discover `browser_setup` through global tool search or invoke its known ID.
`{ action: "launch", browser: "edge" | "brave" | "chrome" | "default" }` selects a
browser; use `executablePath` instead of `browser` for an explicit executable.
Explicit selections fail without fallback. Launch creates a fresh private profile
without copying host data or changing Project configuration.

`{ action: "attach", endpoint }` accepts only loopback HTTP(S)/WS(S) CDP endpoints,
including preenabled compatible Electron targets. For example,
`http://127.0.0.1:9222` or `ws://127.0.0.1:9222/devtools/browser/...`.
This is separate from startup/import flags. Setup connects/lists live contracts,
not business tool RPCs, and returns an opaque `instance` ID with
`source: "tools:chrome-devtools"`, `mode`, `owned`, and `ready`.

Pass `instance` at the top level of subsequent `search`/`invoke_tool` requests.
Omitting it is allowed with one instance, not with two or more; there is no
mutable current browser or fallback for invalid/other-session IDs. Without setup,
automatic lazy default launch remains available in an owning session. Use `{ action: "list" }` or
`{ action: "close", instance }` through `browser_setup` to manage instances.
Close/sleep/reset releases owned instances but only disconnects attached targets,
never kills them. Blocking leaf calls/snapshots borrow the owner's instance IDs
and may interact/list, not launch/attach/close; ordinary tasks/sessions stay
independent. Without an existing owner browser, automatic discovery/invocation
fails asking the owner to initialize first, never creates a persistent resource
in a leaf.

Global `tools:` search lists already-loaded browser contracts with per-result
`instance` IDs without reconnecting. Uninitialized browser sources and live
refresh stay deferred unless explicitly selected.

## Managed startup imports

Import arguments and `.chrome-devtools.json` accept
only `--remote-debugging-port` (1-65535, consumed by the allocator), and these
boolean switches: `--usage-statistics`, `--performance-crux`,
`--category-emulation`, `--category-performance`, `--category-network`.
Camel-case aliases and `--no-` variants are also accepted; boolean values may
use `=true` or `=false`. Omit the port for automatic allocation.

All other flags are rejected, including external endpoints, auto-connect,
custom profiles, executable/launch flags, and unknown future options. Use explicit
`browser_setup` for session launch/attach, not raw flags. The Project's
`tools.chrome.executablePath` remains a configured default.
This controls the built-in adapter, not arbitrary host commands or custom MCPs.
Startup import/preload arguments are pinned per instance; changing them cannot
silently create another browser. Empty
`preload_tools: { "chrome-devtools": [] }` remains supported.

## Recovery

Use automatic port allocation unless the task requires a specific free port.
If a launch port is occupied, use automatic allocation; never implicitly attach
the existing process. Attaching requires an explicit setup request and a
preenabled loopback CDP endpoint.

If an expected tool is absent from a successful complete source listing, check
whether its category has been disabled in the managed configuration and report
that limitation. Do not silently change category or telemetry settings.

Upstream may support additional flags, but that does not make them permissible
in a Project runtime. Do not run a separate server, use `--help` to infer browser
action syntax, or copy host profiles to work around a managed configuration
error. External MCP setup is a different task covered by `v:skills/mcp-config`.
