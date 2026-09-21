# Two-device Electron pairing

This is the trusted-network test path: one Electron installation runs **Main**,
and a second installation runs **Child**. Main owns projects, conversations and
providers; Child supplies execution on its own machine. Use matching builds on
both devices. This is not a production distributed-release certification.

Browser access and device pairing are different. **Connect browser** authorizes
a web UI; it does not register a Child or make that browser an execution node.

## Before starting

- Put both devices on a trusted LAN or VPN. The built-in device listener uses
  unencrypted HTTP with explicit consent on both sides. A VPN may encrypt its
  own tunnel; Shadow does not add TLS to this listener.
- Do not forward this port to the Internet or use it on an untrusted network.
  PINs, protocol payloads and remote job data traverse this connection.
  Device authentication does not make cleartext transport confidential.
- Use a private IPv4 interface assigned to Main. LAN, link-local and
  carrier-grade NAT/VPN addresses are supported. Wildcard/public-address
  binding and IPv6 are not part of this listener's setup.
- Child needs an accessible protected credential store: Windows CurrentUser
  DPAPI, macOS Keychain, or Linux Secret Service with `secret-tool`. Linux
  normally needs an unlocked login keyring and a working user D-Bus session.
  A missing or locked store fails; there is no plaintext-key fallback.
- Both applications must remain running. This does not install an autostart
  service, configure the OS firewall, or wake a sleeping device.

## Pair the devices

1. Start Electron as **Main** and open **Nodes > Pair a Child device**. Select
   **Main's network address** on the LAN/VPN the other device can reach.
   **Port settings** defaults to `3124` (allowed range `1024` through `65535`).
   Acknowledge the trusted-network HTTP warning, then select **Enable device
   connection**. The regular app/admin gateway remains on its existing
   address; this action opens a separate device-only listener.
2. Select **Create invitation** on Main. Use **Copy endpoint**, **Copy ID** and
   **Copy PIN** to transfer the three values to Child before expiry. Keep these
   details private. The endpoint must use Main's address, not `localhost` on
   the Child device.
3. On the second Electron installation, choose **Child > Continue as Child**.
   Enter Main's endpoint, offer ID, six-digit PIN and the device name. Choose
   separate **Child home** and **Shared work folder** paths and acknowledge
   the execution/transport scope. Select **Pair and open local status**.
   The Child creates its identity through its OS credential store, not in the
   renderer. The shared folder is advertised as the `desktop-workdir`
   capability after authentication.
4. Under **Verify pending devices** on Main, compare the full **Device identity
   fingerprint** with Child. Check both the fingerprint and execution-consent
   boxes, then choose **Approve device**. Do not approve a mismatched or
   unexpected request.
5. Wait for a real **Connected** state and workdir capability advertisement.
   A submitted request, a locally ready Child backend and an approved registry
   record are not, by themselves, evidence of a connected Child.

Pairing authorizes the trusted Main to invoke supported Child capabilities.
Commands run with the Child user's OS permissions. Workdir routing and file
checks are not an OS sandbox, and this flow does not add per-command approval
prompts.

Before any credential reference is saved, a failed attempt can correct the
endpoint, HTTP opt-in and shared work folder while retaining the same node
identity, protected key and home. The PIN clears after each attempt. A saved
pairing or pending reference pins the endpoint/scope; retry resumes it rather
than silently pairing a different Main.

## Prove that work runs on Child

Create a small, non-sensitive text file in the Child work directory with
content that does not exist on Main. In Main's new-conversation composer, select
the connected Child workdir as the execution location, then send the first
message to create that remote conversation.

Ask the agent to read the file and execute a harmless foreground command in
that directory. Verify the returned content and working directory belong to
Child. The command must be appropriate for the Child OS, not Main's OS.
Disconnect Child and verify the remote location becomes unavailable rather
than silently executing on Main.

Remote sessions still use Main's configured provider. File access and a
foreground OS-shell command are useful first checks; do not start with remote
browser automation, inline TypeScript, attachments or background processes.
Those are not implied by successful pairing. See the
[remote locality contract](architecture.md#locality-contract) for supported
operations and remaining limits.

## Restart and connection recovery

Role/configuration and the credential reference survive Electron restart.
The protected private key stays in the Child's OS credential store. Main
persists the approved device registry and the explicitly enabled network
settings. Existing pairings do not require another PIN on each launch.

When Main restarts, Child reconnects through the device challenge protocol.
When Child restarts, it restores its existing identity. Pending approval or a
disconnected Main must remain visible as such, not as a successful connection.
An offline device does not become a local execution fallback.

Main's network setting is stored in `device-network.v1.json` beside its
cluster registry. If a saved interface disappears, Main itself still starts;
Nodes reports the device-listener error. Select the current address and retry.
Keep Main's address stable. A successfully paired Child's endpoint is pinned;
the current recovery UI retries that saved connection. Automatic LAN discovery,
endpoint migration and an explicit reset/re-pair UI are not implemented.
Restoring the saved Main address/port restores the existing connection; do not
delete identity data as an ordinary troubleshooting step.

**Turn off listener** stops this listener and disconnects its attached
Children. It is not device revocation: the trusted identity remains persisted,
so re-enabling the same endpoint permits reconnect. No revocation UI is
claimed by this milestone.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No suitable address on Main | Connect its LAN/VPN first. `127.0.0.1` is only for same-machine testing. |
| Device port already in use | Pick an unused port on Main and use the resulting endpoint on Child. |
| Child cannot reach Main | Check the selected interface, port, network isolation and OS firewall. Allow only the intended trusted network; do not open public access. |
| Key-store error | Unlock/restore the OS credential store in the same user login session, then retry. Do not replace it with a plaintext file. |
| PIN rejected or expired | Create a fresh invitation on Main and submit its matching offer ID and PIN. |
| Pending approval | Compare the fingerprint on both devices and approve the correct request on Main. |
| Approved but offline | Keep both apps running; check the listener and network. Approval is not an online signal. |
| Device administration unavailable in a browser | Use the Main Electron window. Browser login cookies do not authorize device administration. |
| UI still says Child setup is unavailable | Rebuild/update and restart Electron. Vite hot reload does not update the main process or backend. |

## Verification boundary

Electron invokes the compiled backend entry as
`index.js child pair --config <absolute-config-path>` in Electron Node mode.
The bounded pairing request, including the PIN, travels through stdin, never
command-line arguments. Packaged builds use
`resources/backend/dist/src/index.js`; source-only pairing scripts are not
required. The Child status endpoint `/local/v1/child` is authenticated and
loopback-only; it is not a remote chat proxy.

The automated integration uses real local TCP HTTP/WebSocket connections,
production pairing and Child runtime code, persisted device references and
registry state, and Child-only filesystem/process work in disposable
directories. It exercises wrong-PIN/fingerprint rejection, pending approval,
disconnect/reconnect and restart. Its injected test key store is not OS
Keychain/Secret Service acceptance.

Separately, the compiled entry was exercised under Electron Node and plain Node
with a synthetic real Windows DPAPI credential, including reuse of the saved
reference. This does not establish native macOS/Linux credential-store behavior.

A companion case starts the actual Main host and creates a remote conversation
through its project-scoped HTTP API, verifies Child-backed folder/file access,
and checks provider-free command history and remote locality after Main restart.
Neither case requires a provider account or sends prompts to an external model.

Passing those checks is not a two-physical-device test, macOS/Linux packaging
acceptance, firewall validation, OS credential-store certification, or full
remote-tool parity. Run the workflow above on the intended devices and test
builds before relying on unattended operation.
