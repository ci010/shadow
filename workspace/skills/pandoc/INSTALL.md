# Installing Pandoc

The simplest way is to use the official installer from the [download page](https://github.com/jgm/pandoc/releases/latest).

## macOS

**Homebrew** (recommended):

```bash
brew install pandoc
```

**MacPorts**:

```bash
port install pandoc
```

Or download the `.pkg` installer from the [releases page](https://github.com/jgm/pandoc/releases/latest).

## Linux (Debian/Ubuntu)

Download the latest `.deb` from the [releases page](https://github.com/jgm/pandoc/releases/latest), then:

```bash
sudo dpkg -i pandoc-*.deb
```

Or install from your distro's package manager (may not be the latest version):

```bash
# Debian/Ubuntu
sudo apt-get install pandoc

# Fedora
sudo dnf install pandoc

# Arch
sudo pacman -S pandoc
```

## Windows

**Chocolatey**:

```powershell
choco install pandoc
```

**winget**:

```powershell
winget install --source winget --exact --id JohnMacFarlane.Pandoc
```

Or download the `.msi` installer from the [releases page](https://github.com/jgm/pandoc/releases/latest).

## Conda Forge (cross-platform)

```bash
conda install -c conda-forge pandoc
# or
pixi global install pandoc
```

## Docker

```bash
docker run --rm --volume "$(pwd):/data" --user $(id -u):$(id -g) pandoc/core INPUT -o OUTPUT
```

## Verify installation

```bash
pandoc --version
```
