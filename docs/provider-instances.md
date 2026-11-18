# Provider instances and multiple accounts

App settings → Providers can add more than one connection of the same type,
including multiple GitHub Copilot accounts on the same GitHub host and multiple
DeepSeek API keys. Each connection has an immutable instance ID and an editable
display name. Cards show both; the model picker shows the display name, provider type and instance ID beneath
the model. Search matches the account name and type as well as the model and ID.
Default-model choices also show these labels while persisting only the qualified ID.
Use **Rename** to change the label without changing credentials or model references.
API-key edits retain the existing key when the key field is left blank.

New connections prefill an editable, required display name: GitHub Copilot,
GitHub Copilot with the selected GHE host, the API provider's display name, or
the custom provider name (initially `local`). The suggestion follows connection
choices until you edit it. After an edit, switching methods or hosts preserves
your text; clearing the name blocks saving/sign-in. Existing names are preserved.

## Account usage on provider cards

Opening **App settings → Providers** checks the account figures separately from
connection readiness. Reopen Providers to check again. A failed or unsupported
lookup shows “unavailable,” not zero, and does not change model access.

- **GitHub Copilot** uses the saved sign-in for that instance and its GitHub host.
  The same internal entitlement endpoint already used during Copilot sign-in
  can report a finite AI-credit allowance and remaining credits. If both are
  present, the card shows included credits used against that allowance. Legacy
  request counts, unreported quotas, and local cost estimates are not used in
  this calculation. This endpoint is not a public REST contract: some plans or
  sign-ins may not return a usable allowance. See [GitHub's billing guidance](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)
  for account-wide usage and billing details.
- **DeepSeek API key** uses DeepSeek’s official [Get User Balance API](https://api-docs.deepseek.com/api/get-user-balance).
  The card shows the returned total balance for each currency and notes when
  DeepSeek says it is insufficient for API calls. The balance is not a spending
  limit. The check is not made for custom endpoints or DeepSeek Account browser sign-in.

## Configuration and compatibility

The `providers` record key is the stable instance ID. Optional `type` chooses the
client implementation and endpoint defaults; optional `name` is only a label:

```json
{
  "providers": {
    "copilot": {},
    "work-copilot": { "type": "copilot", "name": "Work GitHub" },
    "deepseek": { "apiKey": "example-only-legacy-key" },
    "work-deepseek": {
      "type": "deepseek", "name": "Work DeepSeek", "apiKey": "example-only-work-key"
    }
  },
  "agent": { "model": "deepseek-flash@work-deepseek" }
}
```

Old entries without `type` still use the record key as the type. Old references
such as `model@copilot`, `model@deepseek`, and bare model names keep their existing
routing rules. New references use `model@instanceId`, never the display name.
Renaming or adding connections does not rewrite App/project defaults or existing
conversation references. Choose default models separately in App/project settings.
Environment API keys are used only by legacy identities (`deepseek`, `openai`, etc.),
not by additional instances of those types. Additional instances require their own
key or explicitly configured keyless endpoint; no other instance's key is borrowed.

## Copilot isolation

Each instance has its own login attempts, credential refreshes, sign-out revision,
active GitHub host, persisted tokens, and model cache. The legacy `copilot` instance
retains the token-directory environment setting. Credential filename overrides must
be distinct safe basenames (letters/digits, `_`, `-`, and internal dots): paths,
reserved metadata/Windows device names and `.protected` suffixes fail closed.
Nonstandard accepted filenames are encrypted exactly like the defaults. Additional
instances use `instances/<instanceId>/` below that token directory, with fixed token
and cache filenames; filename environment overrides do not redirect these accounts
to legacy files. Enterprise host subdirectories remain within each instance.

Login, status polling, cancellation and logout HTTP requests accept
`?provider=<instanceId>`; omission retains legacy `copilot` behavior. This is still
user-initiated device authorization, not background account polling. Adding a new
Copilot connection registers its identity before login; if login is cancelled, its
card remains available for retry. Signing out does not remove the connection or
select another account. It removes that instance's credentials for its active host,
as before; other hosts and other instances are unchanged.

## GitHub Copilot provider v2

`copilot` now selects **v2** by default, so existing `model@copilot` references and
named instances with `type: "copilot"` need no model-reference or configuration rewrite.
Credentials from the former short-key flow require a fresh explicit v2 sign-in.
New named Copilot connections created in settings explicitly use `type: "copilot-v2"`.
Both types use the v2 backend broker; the setup form shows its version. Protocol
identity remains `copilot`, preserving Chat/Responses continuity and AI-credit estimates.

V2 uses the validated GitHub Device Code flow and then checks
`https://api.<host>/copilot_internal/user` with the resulting OAuth credential.
It uses that OAuth credential directly at the validated CAPI endpoint, with
`Copilot-Integration-Id: copilot-developer-app`; **v2 does not call the legacy
`/copilot_internal/v2/token` exchange**. The latter returned 404 in real testing
on the licensed `msft.ghe.com` host, while the same OAuth credential directly
returned 27 models from `https://copilot-api.msft.ghe.com/models`.

Cached v2 credentials have an explicit `directOAuth` profile containing clientId,
granted scope and whether expiry is known. V2 does not treat old short keys as OAuth
credentials. A known `expires_in` is measured before the seat request and enforced;
unknown expiry is marked as unknown, not presented as an eight-hour lifetime.
No automatic OAuth refresh protocol is guessed: known expiry or token rejection
requires new authorization. Explicit readiness rechecks share a seat request per
instance; cancelling one waiter does not cancel another. Sign-out and replacement
fence late results. Normal requests never launch interactive sign-in or borrow an
ambient account.

V2 now uses an **App-style, minimal-permission OAuth profile** for both github.com
and hosted GHE (`*.ghe.com`): client `Ov23ctr1Udn5GokVCVJf`, requested scope exactly
`copilot`. The client was traced from the local GitHub Copilot App's native request
construction; the minimal scope subset is an explicit operator choice, not a claim
that the App itself only requests this permission. See [native evidence and boundaries](copilot-app-auth-evidence.md).
The old VS Code-client / GHE authentication profiles and token exchange are removed.

New v2 login responses must include a string `scope` containing the standalone
`copilot` token (comma/ASCII-whitespace separated). Missing, malformed or insufficient
scope fails with `scope_missing` **before** the Copilot access check or persistence.
No retry adds repo/workflow/other scopes. If the enterprise policy or this client does
not accept the minimal request, the flow fails explicitly; successful live authorization
has not been established by synthetic tests. The consent page may name the official
GitHub Copilot App because that is the public OAuth client, not a Shadow-owned app.
Requesting permission does not override enterprise OAuth/SSO policy or grant a license.

Old authentication profiles are not upgraded into valid v2 grants. Explicitly start a
new sign-in to create the direct OAuth profile and verify its granted scope. Storage
migration below changes protection, not authorization or scope. Successful sign-in
replaces credentials without an archived plaintext copy.

### Copilot credential protection

Production Copilot storage encrypts access tokens, API credential profiles and model
caches with AES-256-GCM in `<original-name>.protected` files. A random 32-byte master
key per instance directory is held in the current user's macOS Keychain or Linux
Secret Service (`secret-tool` required). Windows (and WSL) protects that master with
DPAPI **CurrentUser**, storing only its DPAPI ciphertext in `master-key.dpapi`.
No plaintext key is stored beside the encrypted credentials. This is not Windows
Credential Manager integration. LocalService and interactive desktop users do not
share a DPAPI identity; provision/sign in separately in the intended user context.
Never switch to LocalMachine protection to bypass this separation.

The authenticated data binds the absolute instance directory and full credential
filename, separating hosts, instances and token/cache types. Copying ciphertext to
another path, machine or OS user is not credential portability. The nonsecret
`active-host` selection stays plaintext and does not unlock the OS store at startup.
Protected storage is loaded lazily; unavailable/locked stores cause explicit
`storage`/`storage_error` failures, never plaintext fallback. Provider inventory
contains a failing Copilot entry rather than blocking unrelated providers. OS helper
commands are bounded to 15 seconds each but are synchronous to preserve setup's
commit/rollback transaction; an OS prompt/timeout can temporarily delay the backend.

Legacy files migrate **on access**, not by scanning all hosts or instances. Migration
atomically writes ciphertext, rereads and authenticates it, and only then removes the
plaintext original. No plaintext backup is created. Failure leaves the legacy file
untouched where possible and refuses its use. If deletion fails after encryption,
both files can remain: the operation reports failure and subsequent reads retry
cleanup before returning a credential. Untouched instances/hosts and unused old
credential files can therefore remain plaintext until accessed or explicitly removed.
Filesystem deletion does not securely erase old blocks, external backups or snapshots.
Sign-out removes both legacy and protected active-host files, not other hosts/accounts.
Rollback restores encrypted storage and retains the existing revision/epoch fences.
The OS master key is retained after logout. A missing master key fails closed; no
replacement is generated once `.protected-key-created` exists. A crash during key
initialization can leave `.protected-key-lock`: after confirming no Shadow process is
using that directory, an operator may remove the empty lock directory and retry.

This change does **not** revoke an already exposed token, prove that no leak occurred,
or protect against a process running as the same OS user with credential-store access.
Suspected exposure requires a separate authorized GitHub revocation/reauthorization
response. No actual user credentials or Keychain entries were read or modified for
implementation tests; tests use synthetic files and injected OS command runners.

Existing Chat/Responses serialization and billing remain in the shared Copilot base;
v2 supplies credential acquisition and integration headers. This does not extract
credentials from the official App or reproduce its complete runtime token protocol.
Real operator-assisted verification on `msft.ghe.com` passed onboarding, readiness
recheck, 17 selectable models and one `gpt-5-mini` Chat-completions request using the
production classes with isolated in-memory storage. It did not sign the running
installation in or verify every model/Responses path. See the evidence note above.

V2 login failures carry an allowlisted `errorStage` (`oauth_device`, `oauth_token`,
`copilot_access`; legacy `copilot_token` remains understood) and safe HTTP statuses
400–599. The UI distinguishes a server error such as 404 from a connection timeout,
and OAuth rejection from a failed Copilot access check. Raw upstream response bodies,
tokens and arbitrary diagnostics are never returned. A rejected check is not by itself
proof of an absent license: verify the host/account that owns the subscription.
Onboarding requires the access check to succeed before committing credentials.

The old `copilot-v1` authentication flow is no longer available. Explicit v1
configurations remain registered as retired placeholders: Main and settings can
start, but every request addressed to a retired connection fails explicitly without
falling back to another account. Nonselected retired records do not block valid v2
connections. Select another configured connection in settings to continue, or add
a new Copilot connection and sign in. To reuse the retired connection ID, change
its configured type to `copilot` or `copilot-v2`, then sign in again if required. Stop Main before manually changing an existing
instance's type; settings do not switch connection types live. Credentials are not
deleted or rewritten by this removal, and valid v2 sign-ins remain usable. Do not
clear the shared credential directory: it also contains v2 accounts and caches.
To remove an unused retired record, stop Main and remove only that provider entry
from configuration; update any active model/quick-model/agent overrides that still
reference it. Do not remove credential files as part of this configuration cleanup.
Historical sessions remain readable; their old provider references are not migrated.

## Failures and removal

Requests route only to their explicit instance (or the existing primary instance
for bare model names). Unknown named instances produce an error, never a fallback.
There is no automatic failover, account selection or API-key replacement. A model
listing failure in one instance does not suppress other instances' model lists.
A failed primary readiness check likewise does not block discovery or explicit
requests to another account.

The settings UI intentionally does not offer deletion. Sign-out and rename are
supported without invalidating references. If configuration is edited manually to
remove a named instance, references are not migrated or silently reassigned: update
defaults and affected conversations explicitly. A missing primary instance prevents
provider construction; other explicit missing references fail when requested.

## Implementation and verification boundary

`schema.ts` defines optional metadata; `factory.ts` resolves type separately from
identity; `AggregatedProvider` keys routing/catalog IDs by instance. Main and each
project runtime already share the same `CopilotAuthenticator`; its instance registry
keeps refresh and sign-out state consistent across runtime rebuilds. The existing
App provider store persists only shared connections and preserves model defaults.
Model context-window overrides already look up the instance key and need no migration.

Regression tests use mocked HTTP and synthetic, project-local storage. They cover
key routing, token/cache isolation, concurrent login, sign-out, rename, legacy
compatibility, and rendered settings flows. They do not prove live GitHub/DeepSeek
account authorization or replace real-account testing by an operator.

## DeepSeek Account

**DeepSeek Account** is a separate `deepseek-account` type with official browser
PKCE authorization, instance-isolated backend grants and Messages inference.
The original `deepseek` API-key route remains unchanged. See
[DeepSeek Account](deepseek-account.md) for setup, storage/security, supported
text/tool subset, mock verification and external authorization/billing boundaries.
