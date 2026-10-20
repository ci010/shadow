# Real CLI, zero-cost loopback smoke

Run on Windows with Node 24:

    node scripts/a2a-cli-smoke-loopback.mjs C:/Users/ci010-4090/AppData/Local/Shadow/cli-test-tools

Install was authorized explicitly; do not auto-install as part of the harness. Prefix was resolved using `[Environment]::GetFolderPath('LocalApplicationData')` then `Shadow/cli-test-tools`. Official registry metadata (`npm view ... --registry=https://registry.npmjs.org`) verified package names, versions and npmjs tarball locations before installing exact versions with `npm install --prefix <prefix> --registry=https://registry.npmjs.org --no-audit --no-fund @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.304`. There was no existing install at this prefix. No repo dependency/global install or commit.

## Verified result

Last successful assertion-bearing run: temp results directory `C:\Users\CI010-~1\AppData\Local\Temp\shadow-cli-smoke-jKH2MV`; full isolated CLI stdout/stderr in `results.json`. These are disposable diagnostics, not required inputs. Harness and this document are durable repo deliverables.

- Codex: `C:\Users\ci010-4090\AppData\Local\Shadow\cli-test-tools\node_modules\@openai\codex\bin\codex.js`, executed using Node. Version: `codex-cli 0.163.0`.
- Claude: `C:\Users\ci010-4090\AppData\Local\Shadow\cli-test-tools\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Version: `2.1.304 (Claude Code)`.
- Version/help checks succeeded, followed by two turns per provider, all eight processes exited 0; no timeout.
- Exactly four loopback requests: two POST `/v1/responses`, two POST `/v1/messages?beta=true`; all requested streaming. Responses input array grew 4 to 6; Messages history grew 1 to 3.
- Both turns returned `LOOPBACK_OK`. Assertions check Codex completed turns/final messages and identical thread IDs; Claude success schema, no permission denials, and both session IDs equal the explicitly selected UUID.
- Codex emits a non-fatal `item.completed` error item about unknown synthetic model metadata, then completes. Production parser permits that shape.
- Claude computes estimated `total_cost_usd` from synthetic usage; this is not a bill or external request. No real provider was used.

## Isolation and bounds

Fresh temporary HOME/USERPROFILE, CODEX_HOME, CLAUDE_CONFIG_DIR, APPDATA/LOCALAPPDATA and working directory; synthetic tokens only. Does not read or copy operator auth, configuration, or repo context. Child environment constructed from a short OS/path allowlist, not a spread of process.env. Nonessential telemetry/error reporting disabled, HTTP(S) proxy points at a dead loopback port and NO_PROXY permits loopback. This is defense in depth, not an OS firewall/network trace guarantee. No login or external model request is configured. Version/help are repeated inside the isolated harness before execution.

Codex uses never approval, read-only sandbox, disabled web search and workspace network, custom provider config with local base_url and responses wire API. Adds `--skip-git-repo-check` solely because isolated cwd is not a repo. Claude uses the production restricted/print JSON/settings-source suppression/hooks-disabled/strict empty MCP/disabled commands/dontAsk/empty tools arguments. No tool is requested by the fake provider. Explicit native Claude executable avoids the resolver issue below.

35-second process deadlines with Windows process-tree termination; 12-request server ceiling; 2 MB incoming body limit; stdout/stderr caps; loopback listener closed in finally. Temp state/results intentionally retained for inspection. Harness failures throw/assert and exit nonzero. Harness does not install or alter production source.

## Scope and compatibility finding

This tests **real direct CLI processes** and the production-style argv/output contract, not the actual codingRunner or A2A service/full setup. No tool roundtrip was tested. Setup has no explicit custom-provider configuration seam: Codex runner uses its own CODEX_HOME with auth only, not ordinary provider config. Routing it through the local synthetic provider would require pre-seeding private runner config or injecting launch environment/config, which would not prove ordinary setup works. No such bypass or production change was made.

Official Claude npm package 2.1.304 has `bin.claude = bin/claude.exe`, and no `cli.js`. The observed pre-fix production `.cmd` resolver hardcodes `node_modules/@anthropic-ai/claude-code/cli.js`, so default PATH discovery would fail this official fresh install even though explicit absolute native executable works. Parent delegated that production fix separately. npm 11 warned the Claude postinstall script was not approved; the shipped `bin/claude.exe` nonetheless ran successfully, so no lifecycle-script override was enabled.
