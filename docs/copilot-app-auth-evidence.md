# Copilot App OAuth evidence and Shadow's minimal profile

## Evidence source

Read-only static analysis of the installed Windows GitHub Copilot App 1.1.28:

- `github.exe`: 434,477,856 bytes.
- SHA-256: `9c6b432de942373e4763979eaff178abe2a9e0fa6d653c98e1a57161d993b69a`.
- Rust/Tauri/WebView2; embedded Vite/React resources were recovered as inert text.
- Request binding was verified with local PE address mapping and LLVM objdump,
  not inferred from the VS Code extension or from adjacent strings alone.
- Static addresses below use the preferred PE image base `0x140000000`, not ASLR.

The native OAuth profile selector at `0x14934d720–0x14934d784` calls host
classification at `0x14934ec50`. For `github.com` and valid `*.ghe.com`, it returns:

```text
client_id = Ov23ctr1Udn5GokVCVJf
scope = repo read:org user gist project workflow write:plugin_gateway_connections copilot
```

The client constant is at file offset `0xe540604` (20 bytes), and the full scope
at `0xe540618` (81 bytes). Device-code request construction calls this selector
at `0x142617f1b` and binds its returned pointer/length pairs to `client_id` and
`scope` at `0x142617fd9–0x14261801a`. The access-token path also uses the selector
at `0x142614916`.

The classification compares exact `github.com` or suffix `.ghe.com`. Thus
`microsoft.ghe.com` is Enterprise Cloud, not GHES. Other custom-host login is
blocked in the examined desktop entry by the separate GHES-not-yet-available
branch; a fallback profile in a shared helper is not evidence of a complete
GHES interactive flow. Bare `ghe.com` is not an accepted Cloud login hostname.

Native account metadata checks read `scope` and, for `.ghe.com`, require an exact
`copilot` scope token. Relevant functions are `0x14934f060–0x14934f294` and
`0x149356880–0x149356b48`. Callers construct an explicit missing-copilot-scope
message rather than calling every failure an absent Copilot subscription.

The provider's separate seat-check path (`0x1458c5970–0x1458c639c`) calls a
Bearer-authenticated `/copilot_internal/user` request (`0x1459332d0–0x145933f84`),
and distinguishes account, auth, subscription, response, unavailable and network
failures. This does not establish the App's complete runtime credential bridge.

## Deliberate Shadow policy, not a literal clone

The operator explicitly selected **the App client with only `copilot` requested**,
without automatically requesting broader repository, workflow or plugin permissions.
Therefore Shadow v2 requests a subset, not the App's entire scope string.

The new-login token response must include `scope` with the standalone `copilot`
token. It is checked before the Copilot access/seat check and before any grant is persisted. The flow does not retry with more scopes if this
fails. A server may return previously granted scopes in addition to the requested
scope; the implementation verifies membership, not that the entire returned set
is exactly one token.

The public client ID is not a client secret or proof of a Shadow-owned OAuth app.
The authorization page may identify the official GitHub Copilot App. Requesting
this profile does not bypass enterprise approval, OAuth policy, SSO or licensing.
Synthetic tests establish request construction and local fail-closed behavior,
not that GitHub will accept the minimal profile for every account/host.

## Real-host validation and direct OAuth correction

The operator corrected the licensed host from `microsoft.ghe.com` to `msft.ghe.com`.
Results from the former must not be used to conclude that the minimum scope is
insufficient. On `msft.ghe.com`, real operator-assisted device authorization with
this App client and **only copilot** succeeded, and the returned scope included
copilot. The legacy `/copilot_internal/v2/token` returned 404, while direct OAuth
Bearer requests returned 200 from `/copilot_internal/user` and 200 with **27 models**
from `https://copilot-api.msft.ghe.com/models` using the App integration identifier.
The token remained in memory only and was not written to user configuration.

A separately authorized full-App-scope comparison on the unlicensed earlier host
also failed the model check. It did not change production defaults or justify
expanding permissions. The minimum profile remains the production choice.

V2 now uses direct OAuth, validates the seat response and API endpoint, and persists
explicit profile/scope/known-expiry metadata atomically. Known expiry requires a new
sign-in; unknown expiry is marked unknown. No unverified automatic refresh protocol
is claimed. Readiness rechecks use the same token and are fenced against sign-out.
V1 retains the old exchange. Chat/Responses serialization and accounting are shared,
with App integration headers selected by v2.

SDK callback declarations alone still do not prove how every official App runtime
consumes tokens; the implementation is not a complete reproduction of the App SDK.
Old credentials require explicit reauthorization to become direct OAuth credentials.
Failed attempts preserve them; successful sign-in replaces that instance/host's files.
V1 rollback may require another sign-in rather than silently reusing a v2 OAuth token.

## Production-class live verification

With operator-assisted authorization on `msft.ghe.com`, the updated production
`CopilotAuthenticatorV2` and `CopilotProviderV2` were exercised with isolated in-memory
storage (not the user's running installation credentials):

- Device-code request: HTTP 200; OAuth token received with copilot granted.
- `/copilot_internal/user`: HTTP 200 during onboarding and explicit readiness recheck.
- `/models`: HTTP 200; production metadata filtering returned **17 selectable models**
  (the earlier raw diagnostic returned 27 entries before picker filtering).
- `/chat/completions`: HTTP 200 for `gpt-5-mini`, with nonempty text output from a
  minimal test prompt. No unrelated conversation or repository content was sent.
- The direct v2 success path made no `/copilot_internal/v2/token` request.
- The test process exited successfully and cleared its in-memory token/storage map;
  no test token was logged or persisted into the active Shadow configuration.

This verifies real OAuth, access checks, model discovery and one Chat-completions
inference through the updated production classes. It does not establish live disk
persistence/restart, every model/Responses route, or automatic OAuth renewal. Those
remain covered only by the corresponding synthetic tests or are explicit limitations.
The active application must load the new build and perform its own sign-in.
