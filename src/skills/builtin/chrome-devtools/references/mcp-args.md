# Chrome DevTools MCP — CLI Arguments

Full reference for `npx chrome-devtools-mcp@latest` options.

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
