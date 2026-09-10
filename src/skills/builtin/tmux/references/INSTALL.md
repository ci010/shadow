# tmux / psmux — Installation

| Platform       | Binary                     | Command                    |
|----------------|----------------------------|----------------------------|
| Windows        | `psmux` / `pmux` / `tmux`  | `winget install psmux`     |
| macOS          | `tmux`                     | `brew install tmux`        |
| Linux (Debian) | `tmux`                     | `apt-get install -y tmux`  |

On Windows, `psmux`, `pmux`, and `tmux` are identical aliases — all commands work the same.

## Verify

```bash
tmux -V      # prints version; error means not installed
psmux -V     # Windows alias
```

## Windows — alternative methods

```bash
# Scoop
scoop bucket add psmux https://github.com/marlocarlo/scoop-psmux
scoop install psmux

# Chocolatey
choco install psmux

# Cargo (from source)
cargo install psmux
```

## Requirements

- **Windows**: Windows 10 or 11; PowerShell 7+ recommended (`winget install --id Microsoft.PowerShell`)
- **macOS / Linux**: no extra requirements beyond the package manager
