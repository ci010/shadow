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

When a launch credential is configured, Electron Main's **Connect browser**
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
once. Browser sessions last twelve hours and end on logout or backend restart.
PIN login grants application administrator access, **not** service-management
or device-enrollment credentials. Keep both PINs and pairing codes private.

Development Vite may listen on a trusted LAN even though the backend and
inspector remain on loopback. Set `VITE_DEV_HOST=127.0.0.1` before starting
development to limit Vite to this computer. Do not port-forward Vite or the
development Docker stack to the Internet: they serve development assets, and
HTTP is unencrypted. Browser login is not multi-user authorization, and host
tools are not sandboxed. The [mobile client](mobile.md) has a separate HTTPS
endpoint and pairing flow; do not expose the ordinary gateway as a substitute.

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
