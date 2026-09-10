---
name: chrome-devtools-brave-setup
description: Setup instructions for using chrome-devtools-mcp with Brave browser on Windows. Use this when you want to control Brave with chrome-devtools-mcp for web automation, scraping, or testing.
metadata:
  related: chrome-devtools
  coauthor: direct-chat-user
  category: browser
---

# Chrome DevTools MCP — Brave Browser Setup (Windows)

## Key Facts

- **Brave path:** `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`
- **Connection method:** `--browserUrl=http://127.0.0.1:9222` (NOT `--browser-path` or `--executablePath`)
- **Config file:** `workspace/.chrome-devtools.json` — persists args across sessions

## Setup Steps

1. **Kill any existing Brave**, launch with debug port:
   ```bat
   taskkill /f /im brave.exe
   start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --no-first-run
   ```

2. **Verify debug port is open:**
   ```bash
   curl -s http://localhost:9222/json/version
   ```
   Should return JSON with `"Browser": "Chrome/..."`.

3. **Load the tool with browserUrl:**
   ```
   use(path="v:tools/chrome-devtools")
   ```

4. **Test:**
   ```
   chrome-devtools__list_pages  →  should show open tabs
   ```

## Common Pitfall

`chrome-devtools-mcp` defaults to finding Chrome stable channel. It ignores
`--browser-path` for Brave. The correct flag is `--browserUrl` pointing to the
already-running debug port.

## Parallel Subagents — Pre-Launch Browser to Avoid Auto-Launch Conflicts

When spawning **multiple parallel subagents** that all need `chrome-devtools`, **do NOT rely on auto-launch**. Each subagent attempting auto-launch simultaneously causes conflicts and failures.

### Safe Pattern — Pre-Launch + Share One Browser Instance

1. **Before spawning subagents**, launch Brave manually with the debug port:
   ```bat
   taskkill /f /im brave.exe
   start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --no-first-run
   ```

2. **Verify** the debug port is open:
   ```bash
   curl -s http://localhost:9222/json/version
   ```

3. **Ensure `.chrome-devtools.json` exists** with the correct config (so all subagents pick it up):
   ```json
   {
     "args": ["--browserUrl=http://127.0.0.1:9222"]
   }
   ```

4. **Then spawn subagents** — each will connect to the same shared browser instance via port 9222. No auto-launch needed.

### Why This Works
- All subagents share one browser instance → no port conflicts, no duplicate browser processes
- Manual launch bypasses the auto-launch mechanism that fails under parallel load
- The `.chrome-devtools.json` config is read by each subagent's `UseTool`, pointing them at the already-running browser

### What NOT to Do
- ❌ Don't let each subagent auto-launch — they'll race and fail
- ❌ Don't skip `.chrome-devtools.json` — subagents may not find the running browser without it

## Persistent Config

`workspace/.chrome-devtools.json` should contain:
```json
{
  "args": ["--browserUrl=http://127.0.0.1:9222"]
}
```

This is read by `UseTool` on next `use(path="v:tools/chrome-devtools")` call.
