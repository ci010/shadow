#!/bin/bash
set -e

# Ensure XDG_RUNTIME_DIR exists (xpra needs it for its socket)
export XDG_RUNTIME_DIR="/tmp/runtime-$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR"

# Start xpra virtual display server with HTML5 web client.
# When the bot gets stuck on a browser step (CAPTCHA, 2FA, etc.),
# open http://localhost:14500 in your Windows browser to see and
# control Chrome.
xpra start :100 \
  --bind-tcp=0.0.0.0:14500 \
  --html=on \
  --no-notifications \
  --no-mdns \
  --no-pulseaudio \
  --daemon=yes

export DISPLAY=:100

# Execute the main command (bot dev server)
exec "$@"
