---
name: web-network
description: "Control current-session proxy for web search and URL read; 搜索、网页读取的代理切换、直连与网络排障。"
metadata:
  category: tools
---

# Web request proxy

For built-in `search` (`handler: "web"`) and `read` HTTP(S) URLs, read `v:tools/session_proxy` and invoke the dynamic tool:

```js
invoke_tool({ name: "session_proxy", args: { action: "get" } })
invoke_tool({ name: "session_proxy", args: { action: "set", mode: "direct" } })
invoke_tool({ name: "session_proxy", args: { action: "set", mode: "proxy", proxyId: "configured" } })
invoke_tool({ name: "session_proxy", args: { action: "reset" } })
```

`direct` forces direct access; `configured` selects the existing static proxy; `reset` inherits application defaults. Inspect the current policy before changing it. For a temporary diagnostic, retry once after switching and restore the prior policy afterward; keep a user-requested setting until reset.

Only subsequent requests in this session are affected—not browser, shell, MCP or other sessions. Settings clear on session sleep/reset or backend restart. Explicit proxy failures never silently fall back to direct. Remote overrides and explicit PAC selection are unsupported. Firecrawl 403 may require an API key: this controls the connection to its API, not its server-side crawl egress. Do not expose proxy credentials or disable TLS checks. If the tool is absent, report that the backend may need updating; do not emulate it by changing global proxy settings.
