## Optional backend

Add `"backend":{"runtime":"python","entry":"server.py","args":[]}` or runtime
`node` with `server.mjs`, and list that file. The runtime executes the script
without a shell and without inheriting provider credentials or NODE_OPTIONS.
Node is the installed Shadow runtime; Python must already be installed.
There is no automatic dependency installation. Prefer standard libraries or
bundle compatible JavaScript dependencies. Explain extra dependencies before
installing them through the ordinary authorized development workflow.

Node backend `fetch` respects standard HTTP(S) proxy environment settings, or
the existing Windows static system proxy when those are absent. Windows bypass
rules, including private-IP patterns and `<local>`, are preserved; loopback
always stays direct. Settings are captured when the backend starts. No system
settings or TLS checks are changed. PAC/SOCKS settings and credential-bearing
proxy URLs fail explicitly rather than leaking credentials or guessing a route.
This applies to native `fetch`, not arbitrary HTTP libraries or subprocesses.
Do not mistake a network/proxy failure for a missing model; report the affected
resource and a safe cause, keep preparation incomplete, and allow explicit retry.

The service must bind **127.0.0.1** on `SHADOW_APP_PORT`, respond successfully to
`GET /health` within 15 seconds, and authenticate **every** request with
`Authorization: Bearer <SHADOW_APP_TOKEN>`. It receives:

| Variable | Meaning |
| --- | --- |
| `SHADOW_APP_PORT` | Backend listener port |
| `SHADOW_APP_DATA` | Persistent app data directory; use this, not script cwd, for outputs/settings |
| `SHADOW_APP_TEMP` | Per-run temporary directory for intermediate audio/files; removed after owned processes stop |
| `SHADOW_APP_API` | This app's own model gateway origin |
| `SHADOW_APP_TOKEN` | Runtime-scoped app credential; never print, save or put it in URLs |

Frontend `request('/backend/synthesize', {method:'POST',headers:{'Content-Type':'application/json'},body:...})`
forwards to the service's `/synthesize` with app authentication.
Application headers, including custom headers such as `X-Language`, are
forwarded along with the query string and body. The host replaces `Authorization`;
it does not forward browser cookies, `Host`, `Origin`, `Referer`, framing or
hop-by-hop headers (including fields named by `Connection`), `Proxy-*`, `Sec-*`,
`Forwarded` or `X-Forwarded-*`. These are reserved, not application parameters.
Check `capabilities.backend.requestHeaders` and exercise the actual SDK/backend
route: directly invoking a worker does not test this transport boundary.
It returns a Response on success; non-2xx responses throw `AppRequestError` with
`status` and `code`. Catch those failures rather than expecting a failed Response.
Use `.json()` or `.blob()` as appropriate. `status()` also reports capabilities.
Maximum transfer
16 MiB, request timeout 180 seconds. Backend model calls may POST the same
`{messages,maxTokens?}` shape to `SHADOW_APP_API + '/_shadow/generate'` with the
app token. Keep a single model-call path per action to avoid double spending.

The backend has normal host filesystem/process permissions, **not an OS
sandbox**. User approval is required even without LLM access. Do not spawn
detached descendants. Stop must end the owned process tree. Unexpected host
termination is reported as interrupted; do not assume external effects rolled
back. App source is immutable for a run, but writable data is not executable
code approval. Source assets contain no secrets and are served on loopback.

`TEMP`, `TMP` and `TMPDIR` also point to `SHADOW_APP_TEMP`. Use it instead of a
persistent `data/temp` directory for transient audio and scratch output. Normal
stop and failed-start cleanup remove it after child processes exit, even if app
cleanup handlers cannot run. A whole-host crash is not a guaranteed secure erase.
Never place reusable models there. Dependencies must be reconstructible from the
reviewed bundle and explicit preparation flow after deleting the author's workdir;
an absolute author cache/seed is not a deployment dependency.
