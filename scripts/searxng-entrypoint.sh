#!/bin/sh
set -eu

SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
TEMPLATE_PATH="/usr/local/searxng/searx/settings.yml"

if [ ! -f "$SETTINGS_PATH" ]; then
  mkdir -p "$(dirname "$SETTINGS_PATH")"
  cp -f "$TEMPLATE_PATH" "$SETTINGS_PATH"
fi

python3 - "$SETTINGS_PATH" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8')

formats_block = "  formats:\n    - html\n    - json\n"
pattern = re.compile(r"^  formats:\n(?:    - .*\n)+", re.MULTILINE)

if pattern.search(text):
    text = pattern.sub(formats_block, text, count=1)
elif "  formats:" not in text:
    marker = "  # formats: [html, csv, json, rss]\n"
    if marker in text:
        text = text.replace(marker, marker + formats_block, 1)

path.write_text(text, encoding='utf-8')
PY

exec /usr/local/searxng/entrypoint.sh