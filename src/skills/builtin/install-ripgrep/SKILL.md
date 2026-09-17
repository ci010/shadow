---
name: install-ripgrep
description: Install ripgrep (rg) on the current system. Use when the glob or grep tools are unavailable because rg is not installed.
metadata:
  category: setup
---

## Installing ripgrep (rg)

The `glob` and `grep` tools require `ripgrep` (`rg`) to be installed. Follow the steps for the current platform.

### Windows

```powershell
# Option 1: winget (recommended, built into Windows 10/11)
winget install BurntSushi.ripgrep.MSVC

# Option 2: Scoop
scoop install ripgrep

# Option 3: Chocolatey
choco install ripgrep
```

### Linux

```bash
# Debian / Ubuntu
sudo apt-get install -y ripgrep

# Fedora / RHEL / CentOS
sudo dnf install ripgrep

# Arch Linux
sudo pacman -S ripgrep

# Alpine
sudo apk add ripgrep
```

### macOS

```bash
# Homebrew (recommended)
brew install ripgrep

# MacPorts
sudo port install ripgrep
```

### Activate for this session

After installing, use the built-in search paths — no tool registration or
explicit import is needed:

```
search({ space: "glob:", query: "**/*.ts" })
search({ space: "grep:", query: "TODO" })
```

Verify with `rg --version` if unsure whether the install succeeded.
MCP configuration and skill tool declarations do not install host executables
such as ripgrep. No additional tool installation or import step is required.
