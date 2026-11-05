# Browser access and installation

The backend gateway serves the built web UI alongside its APIs. Electron is
optional for browser access, but an Electron-owned backend stops when Electron
exits. A separately started Node backend or the
[Windows service](release.md#opt-in-headless-windows-service) continues
independently. The ordinary gateway listens on loopback by default.

## Local browser login

An ordinary local backend without a launch credential or `.pin` retains its
unprotected local behavior. To enable PIN login, put a private, hard-to-guess
one-line value of 4–128 characters in `.pin` in the backend process's working
directory. The repository-root `.pin` is Git-ignored. Set
`SHADOW_BROWSER_PIN_FILE` to an alternative file path when starting the backend
elsewhere; the environment variable contains the **path**, not the PIN. Restart
after adding, changing, or removing the file. An invalid or unreadable PIN file
fails startup rather than disabling authentication. Do not put the PIN in
URLs, source, or logs.

When a launch credential is configured, Electron Main's **Connect phone or browser**
control can issue a one-use pairing code. Without Electron, an authorized local
terminal can issue one using a protected descriptor:

```powershell
pnpm web:pair --connection 'C:\ProgramData\ShadowService\control\connection.v1.json'
```

Or select a protected credential file and its explicit loopback backend:

```powershell
pnpm web:pair --url http://127.0.0.1:18800 --credential-file 'C:\ProgramData\ShadowService\control\launch-token'
```

These are example paths; use the descriptor for your running backend. Open the
browser URL and enter the code. Codes expire after five minutes and can be used
once. Codes are eight decimal digits (including any leading zero); issuing a new
code invalidates the previous one. Pairing is limited globally to 20 attempts
per minute, shared across clients and login methods. Browser sessions last twelve hours and end on logout or backend restart.
PIN login grants application administrator access, **not** service-management
or device-enrollment credentials. Keep both PINs and pairing codes private.

Development Vite may listen on a trusted LAN even though the backend and
inspector remain on loopback. Set `VITE_DEV_HOST=127.0.0.1` before starting
development to limit Vite to this computer. Do not port-forward Vite to the Internet: it serves development assets, and
HTTP is unencrypted. Browser login is not multi-user authorization, and host
tools are not sandboxed. The [mobile client](mobile.md) has a separate HTTPS
endpoint and pairing flow; do not expose the ordinary gateway as a substitute.

## Phone/browser access on a trusted LAN

In Main Electron's **Connect phone or browser** panel, explicitly select **Enable LAN
HTTP access** after reading the adjacent risk warning. The ordinary gateway
remains on loopback: Main starts separate browser-only listeners on the current
RFC1918 IPv4 network interfaces, using OS-assigned ports. The panel lists real
private interface addresses (including alternatives for multiple interfaces).
Open one of those exact addresses on a phone on the same network and type the
eight-digit code. Choose the interface reachable from that phone; VPN interfaces
may also appear. No private IPv4 interface means LAN pairing is unavailable.

HTTP encrypts nothing. Network observers can intercept the code, browser cookie,
and conversations and may gain full application administrator access. Use only a
trusted private network; never port-forward these ports. OS firewall permission,
Wi-Fi client isolation, VPN routing, or an interface change can prevent access.
Disable the checkbox to close LAN listeners and revoke LAN browser sessions;
Main exit also closes them. Closing the panel alone does not disable LAN access.
This is process-local opt-in, not a saved runtime configuration change.

LAN listeners reject launch-credential headers, device/control ingress and
unauthenticated business APIs. Browser login uses an origin-bound HttpOnly,
SameSite cookie, five-minute single-use codes and shared brute-force limits.
This is browser access, not Child enrollment or an execution sandbox. Phone HTTP
origins are not secure contexts: PWA installation, service workers and some
clipboard/browser capabilities may be unavailable. Real iOS/Android, router and
firewall behavior must be checked on the target network; automated checks do not
certify those devices.

## Install the web app

Build the frontend with `pnpm build:app`, then open it from a trusted HTTPS
origin or localhost and use your browser's **Install app / Add to Home Screen**
action. On iOS, use Safari's **Share → Add to Home Screen**. A phone accessing
`http://192.168.x.x:...` is not a secure context for full PWA support. Do not
bypass certificate warnings or publish an unauthenticated gateway to install
the app.

Installation does not make conversations available offline or keep the backend
running. The production service worker does not cache application pages, API
responses, or conversation history; the installed app still needs a connection
and may require a separate login.

## Inline image references in chat

Pasted browser images with generic clipboard names (such as `image.png`) receive
an explicit “Pasted image” name with a distinguishing suffix. This is a generated
label, not recovery of an unavailable original filename. Other supplied names,
including names from the file picker or desktop native file clipboard, are kept.

Each attached image chip has an **Insert image reference** action, available by
keyboard as well as pointer. It inserts a literal Markdown code-span reference at
the message selection/caret. References contain the readable filename and stable
draft identity; removing another image does not renumber them. Removing an image
also removes its exact inserted tokens from the current draft. Image annotation
retains that identity.

On send (including answers to pending questions), the ordinary message text
includes a reference table pairing each image token with its uploaded path and
its position in the message's media array. This table remains readable in chat
history and model input; it does not require a separate rich-text format or
backend persistence schema.
