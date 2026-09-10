# Parallel Browser Sessions

When the user needs multiple independent browser sessions (e.g. comparing two
sites, testing with different accounts, A/B testing), spawn each with its own
browser instance on a **different debug port** and **separate user data folder**.

Since each parallel session uses a fresh `--user-data-dir`, it starts without
the user's logins. **Copy credential files from the default profile** so each
session inherits the user's saved logins, cookies, and storage.

## Default profile locations

| Browser | Windows | macOS |
|---------|---------|-------|
| Chrome  | `%LOCALAPPDATA%\Google\Chrome\User Data` | `~/Library/Application Support/Google/Chrome` |
| Edge    | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | `~/Library/Application Support/Microsoft Edge` |
| Brave   | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | `~/Library/Application Support/BraveSoftware/Brave-Browser` |

The active profile is usually the `Default` subfolder (or `Profile 1`, etc.).

## Files and folders to copy

Copy these from the default profile into each parallel session's user data
folder (inside the `Default/` subfolder unless noted):

```
Default/Cookies              — login sessions, auth tokens (critical)
Default/Login Data           — saved passwords (encrypted)
Default/Local Storage/       — localStorage data (many apps store tokens here)
Default/Session Storage/     — sessionStorage data
Default/IndexedDB/           — some SPAs store auth tokens here
Default/Network/             — HSTS state, network prediction
Default/Web Data             — autofill, saved form data
Default/Preferences          — profile preferences
Default/Secure Preferences   — tamper-protected preferences
Local State                  — OS encryption key for Cookies/Login Data (parent dir, not inside Default/)
```

> **Important:** `Local State` lives in the user data root (next to `Default/`),
> not inside the profile folder. Without it, encrypted fields in `Cookies` and
> `Login Data` cannot be decrypted and logins will not work.

## Example setup script (Windows)

```powershell
$src = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$base = "<workspace>/.browser"

# Create session directories
foreach ($s in @("session-a", "session-b")) {
  $dst = "$base/$s"
  mkdir -Force "$dst/Default" | Out-Null

  # Copy credential files from default profile
  foreach ($item in @("Cookies","Login Data","Web Data","Preferences","Secure Preferences")) {
    Copy-Item "$src/Default/$item" "$dst/Default/" -ErrorAction SilentlyContinue
  }
  # Copy credential folders
  foreach ($dir in @("Local Storage","Session Storage","IndexedDB","Network")) {
    if (Test-Path "$src/Default/$dir") {
      Copy-Item "$src/Default/$dir" "$dst/Default/$dir" -Recurse -ErrorAction SilentlyContinue
    }
  }
  # Copy encryption key (parent level)
  Copy-Item "$src/Local State" "$dst/" -ErrorAction SilentlyContinue
}
```

## Launch and connect

```bash
# Session A — port 9222
<browser-path> --remote-debugging-port=9222 --user-data-dir=<workspace>/.browser/session-a

# Session B — port 9223
<browser-path> --remote-debugging-port=9223 --user-data-dir=<workspace>/.browser/session-b
```

Spawn one subagent per browser instance, each pointing to its own port:

```
subagent(
  task: "Browse site A and extract pricing data",
  preload_tools: { "chrome-devtools": ["--remote-debugging-port=9222"] }
)

subagent(
  task: "Browse site B and extract pricing data",
  preload_tools: { "chrome-devtools": ["--remote-debugging-port=9223"] }
)
```

Each subagent gets its own MCP connection and tool namespace (`browser-a__*` vs
`browser-b__*`), so they run fully independently. Use different `name` values in
the `mcp` config to avoid collisions.
