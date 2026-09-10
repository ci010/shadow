---
name: docker-install
description: "Install Docker Desktop on Windows, macOS, or Linux. Use when asked to install Docker or set up a Docker environment."
metadata:
  category: setup
---

# Docker Desktop Installation

## Automated Install (Recommended)

Use the bundled scripts to automatically detect the OS/arch, download the latest installer, and install.

**macOS / Linux** — `docker-install.sh`:
```bash
bash ./assets/docker-install.sh
# Accept license non-interactively
bash ./assets/docker-install.sh --accept-license
# macOS: run privileged setup as a specific user
bash ./assets/docker-install.sh --accept-license --user=<username>
```

**Windows** — PowerShell (`docker-install.ps1`):
```powershell
.\assets\docker-install.ps1
# Accept license, choose backend
.\assets\docker-install.ps1 -AcceptLicense -Backend wsl-2
# For non-admin user environments
.\assets\docker-install.ps1 -AcceptLicense -AlwaysRunService
```

**Windows** — Command Prompt (`docker-install.bat`, wraps the `.ps1`):
```cmd
.\assets\docker-install.bat
.\assets\docker-install.bat --accept --hyper-v
.\assets\docker-install.bat --accept --service
```

---

## macOS

### System Requirements

- **macOS 14.0 or later** for Docker Desktop (4.x+ hard requirement — will refuse to install on older versions)
- Apple Silicon or Intel
- At least 4 GB RAM

> ⚠️ Docker Desktop officially requires macOS 14+. For **Intel macOS 12**, the install script uses a known legacy Docker Desktop build (`https://desktop.docker.com/mac/main/amd64/135262/Docker.dmg`). Apple Silicon on macOS < 14 is not supported; consider upgrading macOS.

### Download

- Apple Silicon: https://desktop.docker.com/mac/main/arm64/Docker.dmg
- Intel: https://desktop.docker.com/mac/main/amd64/Docker.dmg
- Intel (legacy macOS 12 fallback): https://desktop.docker.com/mac/main/amd64/135262/Docker.dmg

### Install

```bash
sudo hdiutil attach Docker.dmg
sudo /Volumes/Docker/Docker.app/Contents/MacOS/install
sudo hdiutil detach /Volumes/Docker
```

Optional flags for `install`:
- `--accept-license` — accept the license non-interactively
- `--user=<username>` — run privileged setup once during install (avoids root prompt on first launch)
- `--allowed-org=<org>` — require sign-in to a specific Docker Hub org

---

## Windows

### System Requirements (WSL 2 backend, recommended)

- Windows 11 64-bit: Home/Pro 22H2+ or Enterprise/Education 22H2+
- Windows 10 64-bit: Home/Pro 22H2 (build 19045)+
- WSL version 2.1.5+
- 64-bit CPU with SLAT, 4 GB RAM, hardware virtualization enabled in BIOS/UEFI

### Download

- x86_64: https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe
- Arm (Early Access): https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe

### Verify / Install WSL

```powershell
# Check version
wsl --version

# Install or update (run as Administrator)
wsl --install
wsl --update
```

Alternatively, download the `.msi` installer from the [WSL GitHub releases page](https://github.com/microsoft/WSL/releases) if Microsoft Store is blocked.

### Install

If your admin account differs from your user account, add the user to `docker-users` after install:

```cmd
net localgroup docker-users <username> /add
```

```cmd
"Docker Desktop Installer.exe" install
```

PowerShell:
```powershell
Start-Process 'Docker Desktop Installer.exe' -Wait install
```

Key installer flags:
- `--accept-license` — accept license silently
- `--backend=wsl-2|hyper-v|windows` — select backend (default: `wsl-2`)
- `--always-run-service` — run `com.docker.service` automatically (needed when user lacks admin rights for Hyper-V/Windows containers)
- `--installation-dir=<path>` — change install location (default: `C:\Program Files\Docker\Docker`)
- `--allowed-org=<org>` — require sign-in to a Docker Hub org

---

## Linux

### Supported Distros (`.deb` / `.rpm` packages)

| Distro | Supported |
|--------|-----------|
| Ubuntu | ✅ |
| Debian | ✅ |
| RHEL   | ✅ |
| Fedora | ✅ |
| Arch   | Experimental |

### General System Requirements

- 64-bit kernel with CPU virtualization support
- KVM virtualization support (see below)
- QEMU 5.2+
- systemd init system
- GNOME, KDE, or MATE desktop (for GNOME, install the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) for tray icon support)
- At least 4 GB RAM

> Note: Docker Desktop on Linux runs inside a VM, creating a `desktop-linux` Docker context. Images/containers from a pre-existing Docker Engine installation will not be visible.

### Enable KVM Support

```bash
# Load KVM modules
modprobe kvm
modprobe kvm_intel   # for Intel CPUs
modprobe kvm_amd     # for AMD CPUs

# Verify
lsmod | grep kvm

# Grant user access to /dev/kvm
sudo usermod -aG kvm $USER
# Log out and back in for group membership to take effect
```

### Install by Distro

Follow the distro-specific guide:
- Ubuntu: https://docs.dockerd.com.cn/desktop/setup/install/linux/ubuntu/
- Debian: https://docs.dockerd.com.cn/desktop/setup/install/linux/debian/
- RHEL: https://docs.dockerd.com.cn/desktop/setup/install/linux/rhel/
- Fedora: https://docs.dockerd.com.cn/desktop/setup/install/linux/fedora/
- Arch: https://docs.dockerd.com.cn/desktop/setup/install/linux/archlinux/

---

## Verify Installation

After launching Docker Desktop on any platform, verify from a terminal:

```bash
docker version
docker run hello-world
```

## References

- Windows: https://docs.dockerd.com.cn/desktop/setup/install/windows-install/
- macOS: https://docs.dockerd.com.cn/desktop/setup/install/mac-install/
- Linux: https://docs.dockerd.com.cn/desktop/setup/install/linux/
