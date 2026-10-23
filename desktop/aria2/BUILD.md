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
libraries; see `.github/workflows/release-check.yml` for the runner setup.
The build script strips debugging symbols before copying the executable into
the package, then checks its version. The output binary is a separate process.
No model files are included.
