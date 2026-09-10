#!/usr/bin/env bash
# Docker Desktop Installer — macOS & Linux
# Usage: bash docker-install.sh [--accept-license] [--user=<username>]
set -euo pipefail

ACCEPT_LICENSE=false
USER_FLAG=""
for arg in "$@"; do
  [[ "$arg" == "--accept-license" ]] && ACCEPT_LICENSE=true
  [[ "$arg" == --user=* ]] && USER_FLAG="$arg"
done

OS="$(uname -s)"
ARCH="$(uname -m)"   # x86_64 | arm64 | aarch64

log()  { echo "[docker-install] $*"; }
die()  { echo "[docker-install] ERROR: $*" >&2; exit 1; }

# ── Download helper ───────────────────────────────────────────────────────────

download() {
  local url="$1" dest="$2"
  log "Downloading $url"
  if command -v curl &>/dev/null; then
    curl -fSL --progress-bar -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress -O "$dest" "$url"
  else
    die "Neither curl nor wget found. Please install one and retry."
  fi
  log "Saved to $dest"
}

# ── macOS helpers ─────────────────────────────────────────────────────────────

mac_major_version() {
  sw_vers -productVersion | cut -d. -f1
}

# ── macOS: Docker Desktop ─────────────────────────────────────────────────────

install_mac_docker() {
  local custom_dmg_url="${1:-}"
  if [[ -n "$custom_dmg_url" ]]; then
    DMG_URL="$custom_dmg_url"
  elif [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
    DMG_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
  else
    DMG_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
  fi

  DMG_PATH="${TMPDIR:-/tmp}/Docker.dmg"
  download "$DMG_URL" "$DMG_PATH"

  log "Attaching DMG..."
  sudo hdiutil attach "$DMG_PATH" -nobrowse -quiet

  INSTALL_ARGS=("/Volumes/Docker/Docker.app/Contents/MacOS/install")
  $ACCEPT_LICENSE && INSTALL_ARGS+=("--accept-license")
  [[ -n "$USER_FLAG" ]] && INSTALL_ARGS+=("$USER_FLAG")

  log "Installing Docker Desktop..."
  sudo "${INSTALL_ARGS[@]}"

  log "Detaching DMG..."
  sudo hdiutil detach /Volumes/Docker -quiet

  rm -f "$DMG_PATH"
  log "macOS installation complete. Launch Docker Desktop from Applications."
}

# ── macOS: entry point ───────────────────────────────────────────────────────

install_mac() {
  local major
  major="$(mac_major_version)"
  log "macOS major version: $major"

  if [[ "$major" -lt 14 ]]; then
    if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
      die "Docker Desktop requires macOS 14+ on Apple Silicon. Consider upgrading macOS."
    fi
    log "Using legacy Intel macOS Docker Desktop build for macOS < 14."
    install_mac_docker "https://desktop.docker.com/mac/main/amd64/135262/Docker.dmg"
  else
    install_mac_docker
  fi
}

# ── Linux ─────────────────────────────────────────────────────────────────────

setup_kvm() {
  log "Setting up KVM..."
  sudo modprobe kvm || true
  sudo modprobe kvm_intel 2>/dev/null || true
  sudo modprobe kvm_amd   2>/dev/null || true
  sudo usermod -aG kvm "$USER" && log "Added $USER to kvm group (re-login required)." || true
}

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    local id="${ID:-} ${ID_LIKE:-}"
    if echo "$id" | grep -qiE "ubuntu|debian|mint|pop"; then
      echo "debian"; return
    fi
    if echo "$id" | grep -qiE "fedora|rhel|centos|rocky|alma"; then
      echo "rhel"; return
    fi
  fi
  echo "unknown"
}

install_linux_deb() {
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    DEB_URL="https://desktop.docker.com/linux/main/arm64/docker-desktop-arm64.deb"
  else
    DEB_URL="https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb"
  fi
  DEB_PATH="/tmp/docker-desktop.deb"
  download "$DEB_URL" "$DEB_PATH"
  log "Installing .deb package..."
  sudo apt-get install -y "$DEB_PATH"
  rm -f "$DEB_PATH"
}

install_linux_rpm() {
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    RPM_URL="https://desktop.docker.com/linux/main/arm64/docker-desktop-aarch64.rpm"
  else
    RPM_URL="https://desktop.docker.com/linux/main/amd64/docker-desktop-x86_64.rpm"
  fi
  RPM_PATH="/tmp/docker-desktop.rpm"
  download "$RPM_URL" "$RPM_PATH"
  if command -v dnf &>/dev/null; then
    log "Installing .rpm via dnf..."
    sudo dnf install -y "$RPM_PATH"
  else
    log "Installing .rpm via rpm..."
    sudo rpm -i "$RPM_PATH"
  fi
  rm -f "$RPM_PATH"
}

install_linux() {
  DISTRO="$(detect_distro)"
  setup_kvm

  case "$DISTRO" in
    debian) install_linux_deb ;;
    rhel)   install_linux_rpm ;;
    *)
      die "Unsupported distro. Install manually:
  Ubuntu/Debian: https://docs.dockerd.com.cn/desktop/setup/install/linux/ubuntu/
  RHEL/Fedora:   https://docs.dockerd.com.cn/desktop/setup/install/linux/rhel/
  Arch:          https://docs.dockerd.com.cn/desktop/setup/install/linux/archlinux/" ;;
  esac

  log "Linux installation complete."
  log "Start:  systemctl --user start docker-desktop"
  log "Enable: systemctl --user enable docker-desktop"
}

# ── Main ──────────────────────────────────────────────────────────────────────

log "Detected OS: $OS, arch: $ARCH"

case "$OS" in
  Darwin) install_mac   ;;
  Linux)  install_linux ;;
  *) die "Unsupported OS: $OS" ;;
esac

log ""
log "Verify installation with:"
log "  docker version"
log "  docker run hello-world"
