# Chrome DevTools MCP — CLI Arguments

## Project-managed imports

Project runtimes, including Default, always connect to
their own managed browser. Import arguments and `.chrome-devtools.json` accept
only `--remote-debugging-port` (1-65535, consumed by the allocator), and these
boolean switches: `--usage-statistics`, `--performance-crux`,
`--category-emulation`, `--category-performance`, `--category-network`.
Camel-case aliases and `--no-` variants are also accepted; boolean values may
use `=true` or `=false`. Omit the port for automatic allocation.

All other flags are rejected, including external endpoints, auto-connect,
custom profiles, executable/launch flags, and unknown future options. Configure
the browser executable through the Project's `tools.chrome.executablePath`.
This controls the built-in adapter, not arbitrary host commands or custom MCPs.

## Upstream CLI reference

The following `npx chrome-devtools-mcp@latest` options describe the upstream CLI,
not the Project import allowlist.

## Connection

| Flag | Description |
|------|-------------|
| `--browserUrl`, `-u` | Connect to a running debuggable Chrome (e.g. `http://127.0.0.1:9222`) |
| `--wsEndpoint`, `-w` | WebSocket endpoint (e.g. `ws://127.0.0.1:9222/devtools/browser/<id>`) |
| `--wsHeaders` | Custom WebSocket headers as JSON (only with `--wsEndpoint`) |
| `--autoConnect` | Connect to a local Chrome 144+ instance via `chrome://inspect/#remote-debugging` |
| `--channel` | Chrome channel: `stable`, `canary`, `beta`, `dev` (default: `stable`) |

## Browser launch

| Flag | Description |
|------|-------------|
| `--headless` | Run in headless (no UI) mode |
| `--executablePath`, `-e` | Path to custom Chrome executable |
| `--isolated` | Use a temporary user-data-dir, auto-cleaned on close |
| `--userDataDir` | Path to user data directory |
| `--viewport` | Initial viewport size, e.g. `1280x720` (headless max: 3840x2160) |
| `--proxyServer` | Proxy server for Chrome (`--proxy-server` flag) |
| `--acceptInsecureCerts` | Ignore self-signed / expired cert errors |
| `--chromeArg` | Additional Chrome args (repeatable) |
| `--ignoreDefaultChromeArg` | Disable specific default Puppeteer args (repeatable) |

## Tool categories

| Flag | Default | Description |
|------|---------|-------------|
| `--categoryEmulation` | true | Include emulation tools |
| `--categoryPerformance` | true | Include performance tools |
| `--categoryNetwork` | true | Include network tools |
| `--slim` | false | Only 3 tools: navigation, JS execution, screenshot |

Use `--no-category-emulation`, `--no-category-performance`, `--no-category-network` to disable.

## Other

| Flag | Description |
|------|-------------|
| `--experimentalScreencast` | Enable screencast tools (requires ffmpeg) |
| `--performanceCrux` | Send URLs to CrUX API for field data (default: true) |
| `--usageStatistics` | Send usage stats to Google (default: true) |
| `--logFile` | Path to debug log file |

## Examples

```bash
# Connect to existing browser
npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222

# Headless with custom viewport
npx chrome-devtools-mcp@latest --headless --viewport 1920x1080

# Disable emulation & performance tools
npx chrome-devtools-mcp@latest --no-category-emulation --no-category-performance

# Slim mode (3 tools only)
npx chrome-devtools-mcp@latest --slim

# Custom Chrome with proxy
npx chrome-devtools-mcp@latest --executablePath /usr/bin/chromium --proxyServer socks5://localhost:1080
```
