# Mobile client and release boundary

Shadow's Capacitor application is a **client of an existing Main**, not a
Main runtime or execution Child. Vue assets are bundled with the native app;
the Node backend, provider credentials, agent loop, SQLite/JSONL history,
shells and MCP processes remain on Main or supported desktop Children.
Capacitor does not embed Node. A mobile installation does not advertise shell
or workdir capabilities.

This is an initial implementation, not evidence of App Store acceptance or
physical-device release certification. Native signing, installation, Keychain /
Keystore behavior, background/resume and TLS access must be verified on real
iOS and Android devices. See [native builds and signing](../mobile/README.md).

## Enable a separate mobile endpoint

The ordinary gateway and existing browser authentication are unchanged.
Mobile access is disabled unless `SHADOW_MOBILE_ORIGIN` is configured. Main
must also have a launch credential (the Electron host supplies one; headless
deployments use their existing protected launch-credential setup).

Set these in Main's process environment before starting it:

```powershell
$env:SHADOW_MOBILE_ORIGIN = 'https://shadow.example.com'
$env:SHADOW_MOBILE_PORT = '3125'
```

This starts an additional HTTP listener on **127.0.0.1:3125 only**. Put a trusted
HTTPS reverse proxy on the same host in front of that listener, using exactly
the configured public origin and a certificate trusted by the phone. Prefer a
private VPN with HTTPS for personal deployments. A minimal Caddy site is:

```caddyfile
shadow.example.com {
    reverse_proxy 127.0.0.1:3125 {
        flush_interval -1
    }
}
```

Obtain certificates and configure DNS/network access through the operator's
normal deployment process. This feature does not install Caddy, alter firewalls,
provision DNS, expose a development server, or disable certificate validation.
Do not proxy the ordinary Main gateway, inspector, Vite, or device listener to
the mobile endpoint. Do not set the upstream listener to a public interface.
Do not enable request-body, authorization-header, or query-string logging on
the proxy: resource URLs contain short-lived read tickets.

Proxy buffering/timeouts must permit SSE. Use trusted TLS end to end between
the phone and the reverse proxy; the unencrypted hop is loopback on Main.
The backend does not trust forwarded headers to determine a caller's address.
The configured origin is an operator assertion about this HTTPS deployment,
not automatic TLS provisioning. Public Internet deployment still requires
operator-managed rate limits, updates and operational review.

## Pair, disconnect and revoke

On the trusted Main computer, reuse an existing protected connection descriptor:

```powershell
pnpm mobile:pair --connection C:\absolute\path\connection.json
```

Or specify its loopback URL and an existing owner-protected credential file:

```powershell
pnpm mobile:pair --url http://127.0.0.1:3123 --credential-file C:\absolute\path\launch-credential
```

Never supply the launch credential as an argument or put it in a mobile build.
The CLI prints the HTTPS address and a five-minute, single-use pairing code.
Enter them in the app. **Pairing grants owner access to application data and
actions**, including projects, chat, configuration and provider setup; it is not
a multi-user or read-only authorization model. Do not share codes with others.
Runtime control, device pairing/network administration and cluster endpoints
are not exposed by the mobile gateway.

Mobile credentials are separate random session tokens, valid for up to twelve
hours. The phone stores them with the native Keychain/Keystore integration,
not localStorage or Capacitor Preferences. Main keeps only access-token hashes
and in-memory session state. Main restart invalidates sessions and requires a
new pairing code; there is no background refresh token or permanent device grant.
Signing out revokes the session; a lost phone can also be revoked from Main:

```powershell
pnpm mobile:pair --list --connection C:\absolute\path\connection.json
pnpm mobile:pair --revoke <session-id> --connection C:\absolute\path\connection.json
```

Expiry, revocation and shutdown abort associated live streams and invalidate
resource tickets. Listing sessions does not return their secrets. Browser
cookies, browser PINs, launch credentials and Child keys cannot authenticate
at the mobile gateway.

## Transport and mobile lifecycle

The bundled app connects only to a validated HTTPS Main origin. Authenticated
fetch carries a bearer header, including streaming live events. Native origins
`capacitor://localhost` (iOS) and `https://localhost` (Android) have an explicit
CORS policy; CORS alone never grants access. Redirects from proxied application
APIs are rejected rather than forwarding credentials to another origin.

Media elements and downloads cannot attach bearer headers. The authenticated
client requests a sixty-second ticket for an exact approved resource URL.
Eligible resources are session media, session/folder raw files, and I/O artifacts.
Interactive HTML previews are source-only on mobile; tickets do not authorize
linked static-page trees. Raw resource responses carry a restrictive sandbox CSP.
These tickets authorize only GET/HEAD (including range reads), not API mutations
or other resources, and expire with the parent session. The general API token
never appears in a URL. Responses are not cacheable.

The phone is not an always-online execution node. Main continues accepted work
while the app is backgrounded or offline; foreground re-entry checks the
session and reconnects live updates against committed history. Notification
delivery, background task execution and offline agent operation are not part of
this release. Camera, microphone and screen-capture I/O are explicitly unavailable
in the native client; it does not request or advertise those permissions.
Manual file selection/uploads and forms remain available. Future
camera/file/location execution capabilities would require
a separate native Child implementation and protocol/lifecycle work.

## Why not mobile Main or the existing Child?

The current Main and Child implementations depend on Node APIs, host processes,
desktop credential-store adapters and filesystem ownership. Capacitor supplies
a WebView and native plugin bridge, not those backend facilities. iOS suspends
ordinary background applications; Android foreground services and background
network access are restricted. Neither platform promises a permanent WebView
worker or connection.

Sources checked for the architecture decision:

- [Capacitor runtime and native bridge](https://capacitorjs.com/docs)
- [Capacitor build environments](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Capacitor production security](https://capacitorjs.com/docs/guides/security)
- [Apple background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Android foreground services](https://developer.android.com/develop/background-work/services/fgs)
- [Android Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)

Android can be built on Windows with its native SDK/JDK toolchain. iOS requires
macOS and Xcode, locally or on CI. An unsigned Android release build or iOS
simulator build is a compilation artifact, **not a signed installable store
release**. Store distribution additionally requires publisher identifiers,
signing credentials, developer accounts and platform acceptance.
