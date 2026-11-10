# DeepSeek Account (browser authorization)

App settings → Providers → **DeepSeek Account** creates an independent
`deepseek-account` connection. Set its display name, choose a connection model,
and select **Sign in with DeepSeek Account**. Desktop opens the official page in
the system browser; Web shows an **Open DeepSeek authorization** link (a second
user gesture avoids popup blocking). Complete approval in the browser and return
to Shadow. The local callback is handled by the backend, not the renderer.
The browser must run on the Main backend device: a remote Web/mobile browser
cannot reach Main through its own `127.0.0.1`. Remote callback relaying is not
implemented.

This does **not** replace the `deepseek` API-key provider. Existing keys,
`DEEPSEEK_API_KEY`, model references and Chat Completions behavior are unchanged.
Account connections never fall back to those keys, another account, or a custom
endpoint. Use `deepseek-v4-flash@<instanceId>` or
`deepseek-v4-pro@<instanceId>` for explicit routing. Existing model-context registry
entries for those model IDs are reused. The account model picker is a conservative
built-in list, not proof of the signed-in account's actual model entitlement.

## Authorization and storage

- POST `https://platform.deepseek.com/auth-api/v0/dsh/auth_init` with a random
  state, S256 PKCE challenge, loopback redirect URI, locale and login source.
- The backend temporarily listens only on `127.0.0.1`, using an OS-assigned port
  and `/oauth/callback`. Host, path, method, single code/state parameters and
  constant-time state comparison are checked. The code is consumed once.
- Only `https://platform.deepseek.com/dsh/authorize` is offered as a browser
  destination. Returned URLs cannot redirect login to another origin.
- POST `auth_exchange` with the code/verifier, the identical redirect URI and
  Shadow's locally generated device UUID and actual OS details. The returned
  completion URL must be on `/dsh/authorized` on the same official origin.
- A validated grant is written atomically to
  `<Main data root>/config/deepseek-account/<instanceId>/grant.json`.
  The grant directory is mode 0700 and file mode 0600 on POSIX. This is a private
  file, **not encryption or an OS keychain**; filesystem backups and privileged
  local processes can access it. Main data root is the runtime's `dataDir` (or its
  legacy `agent.workspace` default), not the selected source workspace. All
  Projects on that Main use the same explicitly named provider instance.
- Only backend code reads grants; no token, verifier or authorization code is
  returned in setup/status responses, browser storage or model metadata.
- Attempts are bounded by the service TTL and a ten-minute local limit. Cancel,
  timeout, errors and shutdown close the callback listener. An exchange completing
  after cancellation cannot commit its grant. Concurrent starts join one attempt.
- Sign-out cancels pending login, aborts the captured grant lifetime and removes
  the local grant before a best-effort official logout request. Network failure
  cannot restore the local grant; server-side logout is not guaranteed. Other
  instances and API keys are unchanged. Rejected inference tokens are invalidated
  only if still current, so an old 401 cannot erase a newer sign-in. No refresh
  endpoint or token expiry is guessed: a 401 requires explicit sign-in again.

## Inference subset

Requests use only `https://api.deepseek.com/v1/messages` with
`x-dsh-auth-token`, `anthropic-version: 2023-06-01`, JSON and SSE headers. Redirects
are rejected. Account grants cannot be sent to arbitrary/custom endpoints.
No Harness user/session/attribution identifiers or third-party OAuth client
identity are copied or synthesized.

The adapter implements text/system history, thinking replay, tool declarations,
assistant tool calls and immediate tool results, incremental UTF-8 SSE text,
thinking and tool-argument deltas, cache-read/cache-write/input/output usage,
HTTP failures, stream error/truncation checks, and caller/sign-out cancellation.
A complete `message_stop` is required before returning any response or tool calls.
Transport requests are not automatically replayed: a failed/interrupted request
may already have been processed or billed. It has a five-minute total deadline.

The intentionally limited initial scope excludes images, Files API, dynamic
mid-conversation tool schema changes and native signature replay. Unsupported
images and reasoning efforts fail explicitly. Supported efforts are `low`, `high`
and `max`; Shadow's shared `medium`/`xhigh` settings map to `high`, as on its
API-key route. Thinking can be disabled. Thinking signatures are not sent back; plain
thinking content is replayed. Vision is explicitly false in model metadata.

## External access and charges

Mock tests demonstrate protocol construction and local lifecycle, **not** that
DeepSeek has granted Shadow third-party account access. No real login, account
credentials or paid model call was used in development. If the official service
requires an approved integration identity or rejects Shadow/loopback callbacks,
that is an external authorization blocker: obtain DeepSeek's approval rather than
impersonating Harness, bypassing restrictions or silently using an API key.
Model availability, quota, pricing and any promotional grants are DeepSeek's
policies. Account login is not a promise of free inference. Shadow does not infer
account pricing from the API-key provider's price table.

## Source basis and verification

Protocol reference: official `deepseek-ai/deepseek-harness` master inspected at
[`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159):

- [`credentials/deepseek-account-platform/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/credentials/deepseek-account-platform/src/index.ts)
  and [`protocol.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/credentials/deepseek-account-platform/src/protocol.ts)
- [`llm/llm-deepseek-account/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-deepseek-account/src/index.ts)
- Shared [`llm/llm-deepseek/src`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-deepseek/src):
  `adapter.ts`, `serialize.ts`, `translate.ts`, `sse.ts`, `credential.ts`,
  `messages-api.ts` and `models.ts`.

Local behavioral coverage: `src/providers/deepseek-account_test.ts` and the
DeepSeek Account cases in `app/src/provider-setup-rendered_test.ts`. These use
synthetic credentials, mocked official HTTP responses and an actual ephemeral
loopback callback listener, never a real DeepSeek session. See
[provider instances](provider-instances.md) for shared connection identity.
