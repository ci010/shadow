# aria2 binary shipped with Shadow

This separate command-line program is aria2 1.37.0, licensed under GPL-2.0-or-later.
The package includes its corresponding source in `aria2-1.37.0-source.tar.gz`,
the GPL text in `COPYING`, the applicable OpenSSL exception in
`LICENSE.OpenSSL`, and the native build script in `build-aria2-native.sh`.
The source is the `aria2/aria2` Git commit
`02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a` from the signed
`release-1.37.0` tag. See https://github.com/aria2/aria2 for upstream.

Build on each target architecture using the pinned checkout and
`bash build-aria2-native.sh <checkout> <output directory>`. The script
requires a native C++ toolchain, Autotools and platform TLS development
libraries; see https://github.com/ci010/shadow-native-deps for the runner setup.
Shadow release CI downloads the complete native bundle from that repository's
`aria2-1.37.0-shadow.1` release instead of recompiling it for each app build.
`scripts/aria2-native-lock.json` pins each platform URL and actual archive SHA-256;
`scripts/download-aria2.ts` checks that digest before safe, allowlisted extraction,
then verifies bundled source/licenses/recipe, native architecture and version.
The bundle includes `wslay-autoconf.patch`; its exact bytes and the build script
are checked against Shadow's owned recipe. The script replays that build-system
AS_CASE fix against the baseline source archive and syntax-checks generated
configure scripts; no compiler flags or library implementation are changed.
When updating the source or recipe, publish a new dependency release first;
never reuse a tag or guess a digest. Review all four native CI gates, then record
the published archive digests in the lock and run the downloader/tests natively.
The build script strips debugging symbols before copying the executable into
the package, then checks its version. The output binary is a separate process.
No model files are included.
