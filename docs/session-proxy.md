# Session web-request proxy override

Current backend behavior (not a browser/network sandbox).

`session_proxy` is a dynamic built-in source in `v:tools/session_proxy`, not a
base tool or extra `search`/`read` parameter. Discover/read it through `v:tools`,
then invoke it through the existing lazy importer:

- `invoke_tool({ name: "session_proxy", args: { action: "get" } })`
- `invoke_tool({ name: "session_proxy", args: { action: "set", mode: "direct" } })`
- `invoke_tool({ name: "session_proxy", args: { action: "set", mode: "proxy", proxyId: "configured" } })`
- `invoke_tool({ name: "session_proxy", args: { action: "reset" } })`

`get`, `set` and `reset` report the override and effective strategy without
returning proxy endpoints or credentials. Inherited strategy reports the live
application default's source and enable flag; per-destination bypass/PAC routing
is resolved by the existing default transport, not guessed by this tool.

## Existing proxy configuration, not a new registry

The application currently has no named multi-proxy registry. Its HTTP(S) network
configuration comes from the existing standard proxy environment variables,
then Windows or macOS system proxy settings. `configured` is a single adapter ID for
that existing configuration, **not** a newly registered proxy address. The list
of supported IDs is not an assertion that a proxy is currently available.

`set` validates and captures the currently configured static proxy, even if the
application's default proxy toggle is off. Unknown IDs, missing static routes,
credentials/unsupported proxy schemes, and Windows/macOS automatic/PAC selection
fail explicitly and leave the previous override unchanged. Set again to capture
changed static settings. No global configuration or environment is modified.

Explicit proxy requests retain existing loopback/bypass safety. A destination
that would bypass the selected proxy, or has no configured route, fails instead
of silently going direct. Connection failures likewise never trigger direct
fallback. HTTP versus HTTPS routing follows the existing proxy resolver.

## Scope and lifecycle

Only subsequent built-in `search` with `handler: "web"` (Firecrawl, Brave, Exa,
Tavily) and `read` HTTP(S) URL fetches use the override. Filesystem/virtual reads,
other sessions and children, browser, shell, MCP and unrelated backend requests
are unaffected. Session tool snapshots share their owner's policy, not another
session's policy. Each request captures its policy before starting and retains
it across redirects and body consumption; changing/resetting the override does
not interrupt or reroute an in-flight request.

Overrides are in-memory session dynamic resources: session sleep/tool reset or
backend restart clears them. They are not persisted in JSONL/SQLite session
state. `reset` resumes the live application default, including future updates
to that default. Explicit requests use a request-local dispatcher, consume the
response body, then destroy the dispatcher; no global dispatcher is changed.

## Firecrawl and remote limitations

This selects the backend-to-search-API connection, not Firecrawl's own server-side
search/crawl egress. Firecrawl's inherited policy keeps its existing single
direct retry after a proxy-IP block. Any explicit session override disables
that retry (including if reset while the request is running), so an explicitly
selected proxy cannot silently fall back to direct.

There is no remote network-policy execution capability. Setting an override
with a remote workdir fails explicitly, and remote-workdir web search remains
unsupported with a specific error. A local override cannot be applied to URL
requests in a remote-workdir context. This does not add remote browser, shell,
MCP, PAC or remote proxy control; existing inherited URL-read behavior is not
redefined as remote execution.

## Verification

Focused tests: `src/tools/session-proxy_test.ts`, web provider/fallback tests,
search/read tests and existing network proxy tests. Transport tests use local
HTTP and CONNECT fixtures rather than paid external search calls.
