# Provider instances and multiple accounts

App settings → Providers can add more than one connection of the same type,
including multiple GitHub Copilot accounts on the same GitHub host and multiple
DeepSeek API keys. Each connection has an immutable instance ID and an editable
display name. Cards show both; the model picker shows the display name, provider type and instance ID beneath
the model. Search matches the account name and type as well as the model and ID.
Default-model choices also show these labels while persisting only the qualified ID.
Use **Rename** to change the label without changing credentials or model references.
API-key edits retain the existing key when the key field is left blank.

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
retains the existing token-directory and filename environment behavior. Additional
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
