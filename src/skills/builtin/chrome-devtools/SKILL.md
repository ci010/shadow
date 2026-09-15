---
name: chrome-devtools
description: >
  Browse websites, fill forms, take screenshots, or interact with web pages.
  Use when the user asks to open a URL, scrape a page, test a web app, or
  automate any browser task.
metadata:
  core: true
---

# Chrome DevTools MCP — Browser Automation

Chrome DevTools MCP gives you full browser control: navigate, click, fill forms,
take screenshots, read page content, and run JavaScript in the page.

All Chrome tools are session-scoped. Call each one through
`invoke_tool({ name: "chrome-devtools__<tool>", args: { ... } })`. The first
call automatically starts the required Chrome DevTools MCP server and imports
the matching tool set.

## Automatic Loading

The default tool set is imported when you first call a common input,
navigation, or snapshot tool, for example `chrome-devtools__navigate_page`.
Calls to a full-only tool such as `chrome-devtools__emulate` automatically
import the full set instead.

Chrome is auto-detected and launched with remote debugging enabled; no manual
setup is required.

## Explicit Import

Use `import_tool` before invocation only when you must configure the connection
or inspect the authoritative schemas provided by the installed MCP version:

```
import_tool(source="v:tools/chrome-devtools")
```

The result lists every imported tool's full name and JSON Schema. Then call it
through `invoke_tool`.

## How auto-launch works

When Chrome DevTools is imported automatically or explicitly:

1. The system detects the Chrome/Edge/Brave executable automatically
2. A remote debugging port is allocated (starting from 9222)
3. Chrome is launched with debugging enabled
4. The MCP server connects to the browser instance

For parallel sessions (subagents), each gets its own port and isolated user
data directory automatically — no manual allocation needed.

In organization runtimes (including the default organization), profiles are
fresh and private to the session. Host browser cookies, credentials, and profiles
are never copied. Sign in separately if needed. Both tool sets reuse the same
managed browser within a session; sleeping releases only that session's browser.
Do not attach a manually launched browser or copy a host profile as a workaround.

## Tool sets

### Default (`chrome-devtools`)

| Category | Tools |
|----------|-------|
| **Input** | click, drag, fill, fill_form, handle_dialog, hover, press_key, type_text, upload_file |
| **Navigation** | close_page, list_pages, navigate_page, new_page, select_page, wait_for |
| **Snapshot** | evaluate_script, take_snapshot, take_screenshot |

### Full (`chrome-devtools-full`)

Loads everything the default set does **not** include:

| Category | Tools |
|----------|-------|
| **Emulation** | emulate, resize_page |
| **Performance** | performance_analyze_insight, performance_start_trace, performance_stop_trace, take_memory_snapshot |
| **Network** | get_network_request, list_network_requests |
| **Console** | get_console_message, lighthouse_audit, list_console_messages |

## When to use a subagent

For complex browsing tasks, delegate to a subagent. This keeps the ~30 MCP tools
scoped to the subagent session and out of the main conversation's tool list.

```
subagent(
  task: "<the actual browser task>",
  preload_tools: { "chrome-devtools": [] }
)
```

Benefits:
- **Scope isolation**: MCP tools only exist in the subagent session
- **Connection lifecycle**: cleaned up when the subagent finishes
- **Parallel browsing**: spawn multiple subagents — each gets its own Chrome
  instance and port automatically

For simple tasks (take a screenshot, read a page), loading directly is fine.

## Parallel browser sessions

For running multiple browser sessions in parallel (different accounts, A/B
testing, comparing sites), see `references/parallel-sessions.md`.

## Troubleshooting (advanced)

If auto-launch fails, read the returned error. Common fixes:

1. **Browser not found**: Set `tools.chrome.executablePath` in
   the organization's configuration to the correct browser path, or ask the user.
2. **Port conflict**: The system auto-allocates ports, but if you need a
   specific port, pass it explicitly:
   ```
  import_tool(source="v:tools/chrome-devtools", args=["--remote-debugging-port=9223"])
   ```
3. **Organization connection/config errors**: Remove external endpoint,
   auto-connect, profile, and launch flags from the import and the organization's
   `.chrome-devtools.json`. Only a managed `--remote-debugging-port` and the
   reviewed category/telemetry switches listed in `references/mcp-args.md` are
   accepted. Occupied ports are rejected, never attached.

The following manual options are **legacy non-organization usage only**; they
are rejected by organization runtimes, including the default organization:

1. **Explicit profile**: To use a specific user data directory:
   ```
  import_tool(source="v:tools/chrome-devtools", args=["--user-data-dir=<path>"])
   ```
2. **Manual browser launch**: Launch the browser
   manually with `--remote-debugging-port=9222`, then save config:
   ```json
   // workspace/.chrome-devtools.json
   { "args": ["--browserUrl=http://127.0.0.1:9222"] }
   ```

## MCP server options

See `references/mcp-args.md` for the managed allowlist and the separate upstream
CLI reference. Upstream support does not imply an option is permitted in an
organization runtime.
