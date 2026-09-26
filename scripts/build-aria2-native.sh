#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$1" && pwd)"
output_dir="$(mkdir -p "$2" && cd "$2" && pwd)"
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
revision='02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a'
if git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  actual="$(git -C "$source_dir" rev-parse HEAD)"
  if [[ "$actual" != "$revision" ]]; then
    echo "Unexpected aria2 source revision: $actual" >&2
    exit 1
  fi
elif [[ ! -f "$output_dir/aria2-1.37.0-source.tar.gz" ]]; then
    echo "Keep the matching source archive alongside binaries built from extracted source" >&2
    exit 1
fi

cd "$source_dir"
if git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git archive --format=tar "$revision" | gzip -n -9 > "$output_dir/aria2-1.37.0-source.tar.gz"
fi
cp COPYING LICENSE.OpenSSL "$output_dir/"
if [[ "$script_path" != "$output_dir/build-aria2-native.sh" ]]; then
  cp "$script_path" "$output_dir/build-aria2-native.sh"
fi

autoreconf -i
common=(--disable-nls --disable-bittorrent --disable-metalink
  --without-libxml2 --without-libexpat --without-libcares
  --without-libssh2 --without-sqlite3)
case "$(uname -s)" in
  Darwin)
    ./configure "${common[@]}" --without-openssl --without-gnutls --with-appletls
    binary='src/aria2c'
    strip_flags=(-S -x)
    ;;
  Linux)
    ./configure "${common[@]}" --with-openssl --without-gnutls
    binary='src/aria2c'
    strip_flags=(--strip-unneeded)
    ;;
  MINGW*|MSYS*)
    ARIA2_STATIC=yes ./configure "${common[@]}" --with-openssl --without-gnutls
    binary='src/aria2c.exe'
    strip_flags=(--strip-unneeded)
    ;;
  *)
    echo "Unsupported aria2 build host" >&2
    exit 1
    ;;
esac
make -j2
strip "${strip_flags[@]}" "$binary"
cp "$binary" "$output_dir/$(basename "$binary")"
"$output_dir/$(basename "$binary")" --version | tr -d '\r' | grep -E '^aria2 version 1\.37\.0$'
