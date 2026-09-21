# Shadow mobile client

This package wraps the shared `app/` renderer with Capacitor. It is a **client
of an already-running Main**, not a Node runtime, Main, Child executor, shell
worker, or offline agent. Native platform sources are checked in; the Capacitor
8.5.2 CLI generated the Android and iOS/SPM projects. Only bundled renderer assets
are loaded. Do not add `server.url`, cleartext traffic, arbitrary navigation,
transport-security exceptions, or a downloaded web application.

`app.shadow.mobile` is a development publisher identifier. **Choose and register
the definitive publisher-owned Android application ID and Apple bundle ID before
a store release**, then update the Capacitor config, Android namespace/application
ID and Java package, Xcode bundle ID, signing profile, and workflow profile check
together. An already published app cannot freely change identity.

## Reproducible setup and build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm mobile:build
pnpm mobile:check
pnpm test:mobile
```

Requirements:

| Tool | Version / requirement |
| --- | --- |
| Node / pnpm | Node 24.15+ / pnpm 12.3.1 (root manifest) |
| Capacitor core, CLI, Android, iOS | Exactly 8.5.2 |
| Capacitor App lifecycle plugin | Exactly 8.1.1 |
| Android | JDK 21, SDK platform/build-tools 36, Gradle wrapper 8.14.3, AGP 8.13.0, min SDK 24 |
| iOS | macOS with Xcode 26; deployment target iOS 15; Swift Package Manager, no CocoaPods |

The build command runs Vite with `--mode mobile --outDir dist-mobile`, records a
mobile-only build marker in `app/dist-mobile`, then runs `cap sync` for both
projects. Capacitor's `webDir` is `../app/dist-mobile`. This output is isolated
from `app/dist`, which Main serves to normal browser clients: a mobile build must
never replace that web application. No backend build is included.
CI can use `pnpm --filter @shadow/mobile build:web` to generate only this
mode-specific web bundle, then sync it on each native runner.
`pnpm mobile:sync` accepts only a marked mobile bundle. `sync` must run after every renderer/dependency change
and before native compilation. It regenerates Capacitor config, plugin lists,
web assets, Gradle dependency paths, and the SPM package. Never commit copied web
assets, native build outputs, signing keys, or machine-specific SDK paths.

```sh
pnpm mobile:android # Build web assets, sync, compile an Android release APK
pnpm mobile:ios     # Build web assets, sync, compile an unsigned iOS simulator app (macOS)
# Equivalent explicit package commands:
pnpm --filter @shadow/mobile build:android
pnpm --filter @shadow/mobile build:ios
```

These commands perform native toolchain preflight and **exit nonzero** if a
required tool is missing or native compilation fails. Android requires
`ANDROID_HOME` (or `ANDROID_SDK_ROOT`) pointing to the SDK with platform 36 and
build-tools 36.0.0, plus JDK 21 on `JAVA_HOME`/`PATH`. iOS requires macOS, selected
Xcode 26+, and its iOS Simulator SDK. They do not merely open an IDE or report
success when an IDE cannot launch. To work interactively, open `mobile/android`
in Android Studio or `mobile/ios/App/App.xcodeproj` in Xcode yourself.

Direct native validation after `mobile:build`:

```sh
# Windows: use .\gradlew.bat in mobile\android.
cd mobile/android
bash gradlew --no-daemon :app:assembleRelease :app:assembleDebugAndroidTest :app:lintRelease
# With a disposable Android emulator/device connected:
bash gradlew --no-daemon :app:connectedDebugAndroidTest

# macOS, from repository root:
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath mobile/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

The APK without signing inputs is **unsigned**, not installable distribution.
The simulator `.app` is **not** a device IPA. `mobile:check` and `test:mobile`
validate source/configuration contracts; they do not compile native languages,
exercise Keychain/Keystore, or establish device/browser parity.

## Credential bridge

The renderer registers `ShadowCredentials` with Capacitor and uses only:

```ts
get(): Promise<{ value: string | null }>
set(options: { value: string }): Promise<void>
remove(): Promise<void>
```

One opaque UTF-8 record is limited to 16 KiB. Android stores an AES-256-GCM
envelope in private SharedPreferences and keeps its key in Android Keystore.
The record is explicitly excluded from cloud backup and device transfer;
application backup is also disabled. Removal deletes both record and key.
iOS uses a non-synchronizing Keychain generic password with
`AfterFirstUnlockThisDeviceOnly` accessibility. It may survive uninstall on the
same device; Disconnect must remove it. Neither platform silently falls back to
plaintext or weaker storage when a key, record, or native plugin fails.

The plugin is app-local: Android registers it before bridge initialization;
iOS uses a custom bridge view controller registered in the main storyboard and
includes both Swift source files in the Xcode target. No camera or broad storage
permissions are requested. iOS declares a local-network usage description.
Native protected storage protects the persisted secret, not JavaScript executing
inside a compromised renderer; authentication and authorization remain Main's
responsibility.

Before distribution, run device tests for empty/get/set/remove/restart, a
16-KiB Unicode boundary and oversize rejection, locked-device behavior, corrupt
Android ciphertext/missing key, backup/restore exclusion, explicit disconnect,
and resume reconnect on both platforms. Keychain/Keystore failure must remain a
visible pairing error. Trusted HTTPS is required for connections; do not work
around self-signed or expired certificates by weakening TLS.

## CI artifacts and signing

Use the **Shadow release build** workflow (`.github/workflows/release-check.yml`)
and select `mobile` or `all` for a branch test build. Relevant pull requests
automatically validate all targets; ordinary pushes do not start a second
release run. `mobile-release.yml` now contains reusable native jobs, not a
separate manual entrypoint. GitHub-hosted runners supply the native SDKs; local
Android or iOS toolchains are not required for this CI path:

* Ubuntu compiles the unsigned release APK and Android device-test APK, and runs
  lint. The device tests cover actual Keystore storage, round trips, removal,
  UTF-8 limits, corrupt records, and missing keys; run them on a disposable
  device/emulator with `:app:connectedDebugAndroidTest` (not run by CI).
* macOS/Xcode 26 compiles a release simulator app without code signing.
* Typechecks and the mobile-mode Vite build run once in shared preparation.
  Both native platforms verify that same-run bundle, sync Capacitor and run the
  mobile suite. Linux uses Xvfb so the
  renderer tests execute instead of silently skipping for a missing display.
* Artifacts are accurately named `android-unsigned-validation-apk` and
  `ios-simulator-validation`, retained for 14 days. Neither is store distribution.

pnpm/Electron downloads, Gradle's user home/build cache and Swift package
downloads are cached. Gradle validation enables `--build-cache`; signed jobs
only read native caches. Swift's cache does not include compiled Xcode
DerivedData, credentials, profiles or signed products. Installed `node_modules`
and mobile/desktop web bundles are never interchanged. See the
[shared build and cache boundaries](../docs/release.md#shared-build-and-cache-boundaries).

Only an explicit manual dispatch of **Shadow release build**, selecting
`mobile`/`all` with `signed_android` or `signed_ios`, enables a
signed job after its native validation passes. Configure the GitHub environment
**`mobile-release` with protected reviewers and trusted branch restrictions**;
PR validation never receives signing secrets. Missing secrets fail the requested
job instead of producing an unsigned file labeled as signed.

Android environment secrets:

* `SHADOW_ANDROID_KEYSTORE_BASE64`: base64-encoded upload keystore.
* `SHADOW_ANDROID_STORE_PASSWORD`, `SHADOW_ANDROID_KEY_ALIAS`,
  `SHADOW_ANDROID_KEY_PASSWORD`: its credentials.

The signed artifact is `android-signed-release-aab`. For local signing set the
three credential environment variables and `SHADOW_ANDROID_KEYSTORE_PATH` to an
absolute path, then run `:app:bundleRelease`. All four signing variables must be
present together. `SHADOW_BUILD_NUMBER` overrides Android's development
`versionCode` (default 1); CI uses the workflow run number.

iOS environment secrets:

* `SHADOW_IOS_CERTIFICATE_BASE64`: exported Apple Distribution certificate with
  private key, in PKCS#12 format.
* `SHADOW_IOS_CERTIFICATE_PASSWORD`: the nonempty PKCS#12 password.
* `SHADOW_IOS_PROFILE_BASE64`: matching **App Store** provisioning profile.
* `SHADOW_IOS_TEAM_ID`: Apple Developer team ID.

The workflow checks profile team, bundle identity, and distribution type, imports
the certificate into a dedicated runner keychain, archives for a generic iOS
device, and exports using `app-store-connect` manual signing. The artifact is
`ios-app-store-signed-ipa`. The build number uses the workflow run number.
Signing material is removed in an unconditional cleanup step. No store upload
or publication occurs. Ensure build numbers exceed existing store versions,
including when moving between workflows/repositories.

Store publication still requires definitive publisher identifiers, developer
accounts, privacy disclosures, export-compliance decisions, store metadata,
review, signed-device testing, and operational Main connectivity. CI compilation
and a signed artifact do not prove release readiness or background execution.

## Artwork

Native icons reuse `app/public/pwa/icon-512.png`, resized into committed native
resources (iOS flattened to an opaque 1024px icon). Splash resources use the same
artwork on an opaque background. These are build inputs, not a separate mobile UI.
Revisit high-resolution publisher artwork before store submission.
