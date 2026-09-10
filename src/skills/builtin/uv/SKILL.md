---
name: uv
description: 'Install and manage Python versions without requiring Python to be pre-installed, using uv — an extremely fast Python package and project manager written in Rust. Replaces pip, pyenv, virtualenv, pipx, poetry. Use when Python is not installed, when you need a specific Python version, when running a one-off Python script with dependencies, or when setting up a Python project. Triggers: "install python", "python not found", "run python script", "need python 3.x", "set up python environment".'
metadata:
  category: setup
---

# uv — Fast Python Package and Project Manager

uv is a single Rust binary that replaces `pip`, `pyenv`, `pipx`, `virtualenv`, and `poetry`. It downloads and manages Python versions on demand — **Python does not need to be installed first**.

## When to Use

✅ USE when:
- `python` / `python3` is not found on the system
- You need a specific Python version (e.g., 3.11, 3.12, PyPy)
- Running a one-off script with pip dependencies without polluting global env
- Setting up a reproducible Python project with lockfile
- Installing CLI tools published on PyPI (`ruff`, `black`, `httpx`, etc.)

❌ DON'T use when:
- Python and pip are already set up and working correctly → use them directly
- The task is purely shell/system — Python isn't needed at all

---

## Install uv

### Windows
```powershell
# Standalone installer (recommended)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# WinGet
winget install --id=astral-sh.uv -e

# Scoop
scoop install main/uv
```

### macOS / Linux
```bash
# Standalone installer (recommended)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Homebrew (macOS)
brew install uv

# pip (if Python already available)
pip install uv
```

After install, `uv` and `uvx` are available in PATH. No Python required.

---

## Python Version Management

```bash
# Install latest Python
uv python install

# Install specific version
uv python install 3.12
uv python install 3.11 3.12 3.13   # multiple at once

# Install alternative implementation
uv python install pypy@3.10

# List installed and available versions
uv python list

# Pin version for current directory (writes .python-version)
uv python pin 3.12

# Upgrade to latest patch
uv python upgrade 3.12

# Create venv with specific version
uv venv --python 3.12
```

After `uv python install`, the versioned executable (e.g. `python3.12`) is added to PATH.  
To also install plain `python` and `python3` executables:
```bash
uv python install --default
```

> **Auto-download**: uv automatically downloads Python when needed. You rarely need to run `uv python install` explicitly — just use `uv run` / `uv venv` and uv will handle it.

---

## Running Scripts

```bash
# Run a script (auto-downloads Python if needed)
uv run script.py

# Run with ad-hoc dependencies (no venv needed)
uv run --with requests --with rich script.py

# Run with a specific Python version
uv run --python 3.11 script.py

# Run inline-dependency script (PEP 723)
uv run example.py   # reads # /// script block for deps
```

### Inline script metadata (PEP 723)
Add dependency metadata directly in the script so `uv run` installs them automatically:
```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich.pretty import pprint
pprint(requests.get("https://example.com").status_code)
```

```bash
uv add --script example.py requests rich   # auto-generates the block
uv run example.py                          # installs deps, runs script
```

---

## Run Tools (uvx / pipx-style)

```bash
# Run a tool in an ephemeral env (no install)
uvx ruff check .
uvx black --check .
uvx httpie GET https://example.com

# Install tool permanently
uv tool install ruff
ruff --version

# Upgrade installed tool
uv tool upgrade ruff
```

---

## Project Management

```bash
# Create new project
uv init myproject
cd myproject

# Add dependencies (creates/updates pyproject.toml + uv.lock)
uv add requests
uv add 'pandas>=2.0'

# Remove dependency
uv remove requests

# Install all deps from lockfile
uv sync

# Run command inside project env
uv run python -c "import requests; print(requests.__version__)"

# Lock without syncing
uv lock
```

---

## pip-compatible Interface

```bash
# Create virtualenv
uv venv
source .venv/bin/activate          # Linux/macOS
.venv\Scripts\activate             # Windows

# Install packages into active venv
uv pip install requests pandas

# Install from requirements file
uv pip install -r requirements.txt

# Compile requirements.in → requirements.txt
uv pip compile requirements.in -o requirements.txt

# Sync environment to exact requirements
uv pip sync requirements.txt
```

---

## Upgrade uv

```bash
uv self update
```

---

## Gotchas

- `uv python install` installs a versioned binary (`python3.12`) by default. For `python` to work, run with `--default` or activate a venv.
- `uv run` inside a directory with `pyproject.toml` will install the current project first. Use `--no-project` to skip.
- Global cache is shared across projects for disk efficiency — safe to delete with `uv cache clean` if space is needed.
- On Windows, after standalone install, restart the terminal so PATH is updated.
