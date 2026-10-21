# Desktop Main / Child profiles

The Electron desktop can retain both a Main profile and a Child profile. It runs
**one role at a time**, not two background services.

- Open **App settings → Desktop role** on Main. Child has the same control in its
  local status page, setup form and runtime recovery screen.
- Select the other role, read the interruption warning, and choose **Stop and
  switch role**. Switching to Child requires explicit consent to the approved
  Main executing OS commands. Shell access is not a sandbox.
- The old runtime, published micro-app windows and setup subprocesses are stopped
  before saving the selection. Shadow then exits and restarts. A packaged app or
  `pnpm dev` supervisor restarts automatically. An unsupervised development launch
  closes and must be opened again manually.
- The first Child visit opens pairing setup. Returning to a configured role uses
  its saved launch options, data directory, device identity and credentials.
  Returning to Main does not delete or unpair Child on the remote Main.
- Running work can be interrupted. This is not a live session migration. Managed
  Main deployments cannot switch roles through this control.

## Compatibility and recovery

The original role retains its existing `userData/bootstrap/*.v1.json` files and
its existing backend data directory. The second role uses
`userData/roles/<role>/bootstrap/*.v1.json`. Electron's browser/window settings
and the host's runtime connection publication remain associated with the original
Electron userData, not a second Electron instance.

A small `bootstrap/role-selection.v1.json` atomically records the active role and
which role owns the legacy paths. It is first written only on an explicit switch.
Loading an old installation does not migrate, copy or overwrite its configuration
or identity. On a fresh installation the first role chosen in setup owns the
legacy paths. Invalid or conflicting role metadata fails closed.

Main data and Child home/work folders must not overlap (including nested folders
and symlink aliases). The desktop validates saved configurations before runtime
startup and new folder selections before publishing configuration. Existing Main
and Child backend ownership/locking rules remain in place.

If shutdown or saving the role selection fails, no target runtime is started in
that process. Close and reopen Shadow; the last successfully saved role selection
wins. Existing profile files remain intact. An interrupted first-time setup is
resumable in its own role. Do not delete device identity files to troubleshoot a
lost pairing response: compare the displayed fingerprint with Main before
approving a pending device.

## Pairing transport and diagnostics

HTTPS remains the normal transport. For trusted local testing only, the desktop
allows HTTP after an explicit checkbox acknowledgement and only for a literal
private LAN/VPN or loopback address (including CGNAT/Tailscale, IPv6 ULA and
link-local addresses), or `localhost`. Public IPs and other DNS HTTP names are
rejected even with the checkbox; use HTTPS or the private numeric address. The
form shows transport errors before submitting a PIN. No invitation automatically
grants HTTP consent, and no TLS verification bypass is offered.

Pairing subprocess failures return finite categories: connectivity/TLS, timeout,
protected OS key store, invitation rejection, incompatible Main response,
configuration, storage, or unknown failure. Raw backend output, caught exception
messages, PINs, invitation contents and private keys are not displayed or echoed
into Electron logs. Unknown/older backend failures keep a conservative generic
message. Main approval and connectivity are still distinct from a successfully
submitted pairing request.
