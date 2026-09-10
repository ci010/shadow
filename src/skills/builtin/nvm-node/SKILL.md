---
name: nvm-node
description: Install or update Node.js to the latest version using nvm (Node Version Manager). Use when asked to install Node.js, set up a Node environment, or when node/npm is missing.
metadata:
  category: setup
---

# Install Node.js via nvm

Use this skill to install Node Version Manager (nvm) and then install the latest Node.js.

## Step 1: Install nvm

Run the official nvm install script:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

After running the script, source the shell config to load nvm into the current session:

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

## Step 2: Install latest Node.js

```bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh" && nvm install node
```

`nvm install node` always resolves to the latest stable release.

## Verify

```bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh" && node --version && npm --version
```

## Notes

- Combine the `NVM_DIR` export with each command because non-interactive shells do not source `~/.bashrc` / `~/.zshrc` automatically.
- If nvm is already installed, `nvm install node` upgrades to the latest version without reinstalling nvm.
- To switch to the new version in subsequent commands, prefix with `export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"`.
