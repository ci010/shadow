> **WIP design/workstream reference, not a security certification.**
> Pairing/device transport implementations do not establish a completed remote
> UI or a production-ready distributed trust boundary. See the
> [status/index](README.md) and [current architecture](../architecture.md);
> preserve the distinction between implemented checks and planned guarantees.

# S3: Cluster Security and Remote API

> Owner: network/security
>
> Depends on: S0; consumes S2 job schemas
>
> Blocks: S5 integration, S6 live integration

## Goal

Implement the authenticated Main-facing network plane for headless administration
and Child execution. Child always initiates connections.

## Owned Modules

- new `src/cluster/` modules
- node registry persistence
- pairing and device authorization services
- remote UI API facade
- node-control WebSocket transport

Do not expose the existing gateway by changing it to `0.0.0.0`. S7 owns local
gateway hardening. S4 owns composition/startup wiring in `src/index.ts`.

## External Listener

One TLS port may host three isolated route groups:

```text
/pair/v1/*             short-lived pairing bootstrap
/remote/v1/*           device-authenticated UI REST/SSE
/cluster/v1/node       device-authenticated node WebSocket
```

Each group has its own middleware and scopes. Pairing credentials cannot call UI
or node APIs. Node execution credentials do not automatically grant Main admin.

## Pairing State Machine

1. Main creates a one-time, short-expiry pairing offer.
2. Child presents offer plus its device public identity.
3. Main records a pending device and shows fingerprints.
4. An existing admin or headless terminal approves/rejects it.
5. Main issues permanent device authorization with UI scopes and node privileges.
6. Child reconnects using the permanent credential.
7. Main can revoke the device and close all active connections immediately.

Pairing is restart-safe, rate-limited, audited, and resistant to replay. Secrets do
not appear in normal logs or process arguments.

### PIN bootstrap profile

The first interactive profile uses a six-digit PIN as a bootstrap secret, not as
a permanent device credential:

- Main shows the PIN once; it expires after five minutes and after five failed
  attempts.
- Main keeps only a salted digest in process memory. Active PINs are invalidated
  by Main restart and the operator creates a new offer.
- A correct PIN consumes the offer and submits the Child public identity to the
  existing pending/fingerprint flow. It does not grant UI scopes or node
  privileges by itself.
- Approval issues a separate device credential. Reconnect uses proof of that
  credential, never the PIN.
- Pairing outside a same-host WSL smoke test requires TLS. A short PIN does not
  protect an unencrypted network from interception.
- The HTTP pairing endpoint adds per-source rate limiting in addition to the
  per-offer attempt bound.

The PIN service and strict `/pair/v1/*` route plugin are mounted in Main,
including bounded request bodies, exact schemas, per-source rate limiting from
the server-captured peer address, and no-store responses. Offer creation and the
headless pending/approval API require the Main launch credential. Pairing,
challenge, and WebSocket routes bypass that bearer only by exact method and
pathname so their own PIN or Ed25519 proof can authenticate the request.

The Ed25519 challenge authority, `/cluster/v1/challenges` route plugin, Child
challenge client, standard WebSocket subprotocol proof, verified identity
binding, and `/cluster/v1/node` session owner are mounted. The registry persists
the Child public key and proposed credential identifier through pending and
approved records. Main restores challenge verifiers after restart, saves each
successful registry mutation through a serialized atomic snapshot adapter, and
closes active node sessions before final shutdown persistence.

The production Child stores private Ed25519 JWK material behind a protected
key-store interface: Windows CurrentUser DPAPI, Windows DPAPI through WSL
interop, or Linux Secret Service. It persists only the provider/key identity
reference in ordinary JSON. Child-owned configuration may bind opaque workdir
capability IDs to local roots; only display metadata and read/write permissions
are advertised to Main. Missing key stores, references, key mismatches, and
non-loopback cleartext transports fail before dialing. Same-host WSL smoke may
explicitly opt into cleartext transport; all other PIN pairing requires TLS.

When the desktop host supplies both a loopback port and its random launch token,
the Child starts a `127.0.0.1` control server with readiness, shutdown, and local
approval routes behind the existing constant-time bearer middleware. A port
without a token fails closed, and a headless Child with neither value opens no
local HTTP listener.

## Remote UI API

The Child local proxy needs authenticated access to Main's product API. Do not
blindly tunnel arbitrary localhost URLs. Define an allowlisted remote API facade:

- chat/session APIs;
- knowledge/wiki APIs;
- node/capability APIs;
- configuration APIs gated by `main:admin`;
- logs/audit APIs gated by their scopes;
- SSE/event streams with reconnect cursor support.

Mutations use revision/idempotency contracts from S0. Device identity is not a
substitute for application user/audit identity.

## Node WebSocket

The long-lived connection supports:

- version/feature negotiation;
- capability advertisement and withdrawal;
- heartbeat and liveness;
- job dispatch and event streaming;
- cancellation;
- artifact transfer negotiation;
- reconnect and deduplicated receipt recovery.

Use bounded queues and backpressure. A slow or malicious node must not block Main's
event loop or consume unbounded memory.

## Security Decisions Required Before Merge

- TLS certificate strategy for LAN IP, DNS, VPN, and public server deployments;
- macOS protected private-key storage and Linux Secret Service deployment;
- credential rotation and public-key snapshot migration;
- rate limits and pairing expiry;
- admin recovery and first-device bootstrap;
- audit retention and secret redaction;
- maximum message, queue, and artifact sizes.

## Tests

1. Expired/replayed pairing offers are rejected.
2. Fingerprint mismatch cannot be bypassed.
3. Pending node cannot advertise or execute capabilities.
4. Revocation closes UI and node channels and blocks reconnect.
5. UI scopes deny unauthorized routes and mutations.
6. Protocol major mismatch fails before capability/job exchange.
7. Reconnect recovers known jobs without duplicate execution.
8. Backpressure and size limits reject abusive peers safely.
9. SSE reconnect resumes from a cursor without cross-session event leakage.
10. Headless terminal can recover when no admin Child is online.
11. Windows Main and WSL Child consume a PIN once, issue a device credential,
    reconnect without the PIN, and reject reuse of the consumed PIN.

## Exit Criteria

- A fake Child can pair, reconnect, advertise a capability, receive a fake job,
  and return a receipt against a headless Main integration test.
- Security review signs off before binding beyond loopback in production defaults.
