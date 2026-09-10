## syntax=docker/dockerfile:1.7

FROM python:3.12-slim-trixie

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ── 1a) Base deps + ripgrep ──────────────────────────────────────────────────
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
 && printf '%s\n' '#!/bin/bash' 'set -euo pipefail' '' 'for attempt in {1..5}; do' '  rm -rf /var/lib/apt/lists/*' '  if apt-get update; then' '    exit 0' '  fi' '  if [[ "$attempt" -eq 5 ]]; then' '    exit 1' '  fi' '  sleep $((attempt * 2))' 'done' > /usr/local/bin/apt-update-safe \
 && chmod +x /usr/local/bin/apt-update-safe \
 && apt-update-safe && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    gnupg \
    unzip \
    dumb-init \
    xdg-utils \
    procps \
    git \
    ripgrep \
    xvfb \
    fonts-liberation \
    fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# ── 1b) Xpra from official repo (not in Trixie default repos) ───────────────
RUN mkdir -p /usr/share/keyrings \
 && curl -fsSL https://xpra.org/xpra.asc -o /usr/share/keyrings/xpra.asc \
 && printf '%s\n' 'Types: deb' 'URIs: https://xpra.org' 'Suites: trixie' 'Components: main' 'Signed-By: /usr/share/keyrings/xpra.asc' 'Architectures: amd64' > /etc/apt/sources.list.d/xpra.sources \
 && apt-update-safe \
 && apt-get install -y --no-install-recommends xpra xpra-html5 xpra-x11 \
 && rm -rf /var/lib/apt/lists/*

# ── 2) Google Chrome (pulls its own runtime deps via apt) ──────────────────
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-update-safe \
 && apt-get install -y google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# ── 3) Node.js LTS ─────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh \
 && bash /tmp/nodesource_setup.sh \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -f /tmp/nodesource_setup.sh \
 && rm -rf /var/lib/apt/lists/*

# ── 4) pnpm (same version as packageManager) ────────────────────────────────
RUN npm install --global pnpm@12.3.4

# ── 5) Non-root user ────────────────────────────────────────────────────────
RUN useradd -m -u 1000 -s /bin/bash appuser \
 && mkdir -p /app /home/appuser/.config/openclaw/github_copilot \
 && chown -R appuser:appuser /app /home/appuser

# ── 6) Git safe.directory (bind-mounted repo may have different ownership) ──
RUN git config --global --add safe.directory /app

# ── 7) Entrypoint script (must be copied as root for /usr/local/bin) ─────────
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app

# ── 8) Copy dependency manifests first (layer caching) ─────────────────────
COPY --chown=appuser:appuser package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=appuser:appuser app/package.json app/package.json
COPY --chown=appuser:appuser desktop/package.json desktop/package.json

USER appuser
RUN pnpm --filter @shadow/shadow --filter @shadow/app install --frozen-lockfile

# ── 9) Copy full source ────────────────────────────────────────────────────
COPY --chown=appuser:appuser . .

USER appuser

# ── 10) Build the backend and production web UI ────────────────────────────
RUN pnpm build:all

EXPOSE 3123 14500

ENTRYPOINT ["dumb-init", "--", "docker-entrypoint.sh"]
CMD ["pnpm", "dev:docker"]
