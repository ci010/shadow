---
name: tmux
description: 'Remote-control tmux/psmux sessions by sending keystrokes and scraping pane output. Use for managing agent sessions (open-code, etc.), monitoring long-running processes, parallel multi-tasking, and keeping work alive across disconnects. Triggers include "send to session", "check on agent", "run in parallel", "launch agent", "monitor process", "tmux session".'
metadata:
  category: platform
---


## Platform Notes

See [INSTALL.md](./references/INSTALL.md) for installation (Windows/macOS/Linux).  
On Windows, `psmux`, `pmux`, and `tmux` are identical aliases — all commands below work the same.

---

## When to Use

✅ USE this skill when:
- Monitoring or interacting with agent sessions (open-code, Codex, etc.) in tmux
- Sending input to interactive terminal applications (TUIs)
- Reading output from long-running processes already in tmux
- Running parallel workloads across multiple panes or sessions
- Keeping sessions alive across disconnects

## When NOT to Use

❌ DON'T use this skill when:
- Running a one-off shell command → use `exec` directly
- Starting a new detached background process that doesn't need interaction → use `exec`
- The process isn't inside a tmux session

---

## Target Syntax

```
session:window.pane   →  work:1.0
session name only     →  work           (targets first window/pane)
pane by id            →  %3
window by id          →  @4
```

---

## Core Session Commands

```bash
# Check / list
tmux list-sessions                        # List all sessions (alias: tmux ls)
tmux has-session -t work && echo exists   # Exit 0 = session exists

# Create / destroy
tmux new-session -d -s work -x 220 -y 50 # Detached named session (set explicit size!)
tmux kill-session -t work
tmux kill-server                          # Destroy everything

# Windows
tmux new-window   -t work -n logs
tmux list-windows -t work
tmux select-window -t work:logs
tmux kill-window  -t work:logs

# Panes
tmux split-window -h -t work             # Side-by-side split
tmux split-window -v -t work             # Top/bottom split
tmux list-panes   -t work
tmux select-pane  -t work:1.1
tmux kill-pane    -t work:1.1
```

## Sending Input

```bash
# ── Regular command ───────────────────────────────────────────────────────────
tmux send-keys -t work "ls -la" Enter

# ── Interactive TUI (Claude Code, Codex, etc.) ────────────────────────────────
# Split text and Enter into two calls to avoid paste/multiline edge cases
tmux send-keys -t work -l -- "Please fix the bug in src/auth.ts"
sleep 0.1
tmux send-keys -t work Enter

# ── Approve a yes/no prompt ───────────────────────────────────────────────────
tmux send-keys -t work "y" Enter

# ── Special keys ─────────────────────────────────────────────────────────────
tmux send-keys -t work C-c             # Ctrl+C (interrupt)
tmux send-keys -t work C-d             # Ctrl+D (EOF)
tmux send-keys -t work Escape
```

## Reading Output

```bash
# Visible screen (last ~50 lines)
tmux capture-pane -t work -p

# Last N lines
tmux capture-pane -t work -p -S -100

# Full scrollback history
tmux capture-pane -t work -p -S -

# Specific window + pane
tmux capture-pane -t work:1.0 -p -S -50

# Live log file (start pipe, then stop)
tmux pipe-pane -t work:1.0 -o "cat >> /tmp/pane.log"
tmux pipe-pane -t work:1.0            # Stop piping
```

---

## Agent Session Patterns

### Start an agent in a dedicated session

```bash
tmux new-session -d -s opencode -x 220 -y 50
tmux send-keys -t opencode "open-code" Enter
# Wait for prompt, then send task:
sleep 1
tmux send-keys -t opencode -l -- "Fix the failing tests in src/"
sleep 0.1
tmux send-keys -t opencode Enter
```

### Check if session is waiting for input

```bash
# Look for interactive prompts
tmux capture-pane -t worker-1 -p | tail -10 | grep -E "❯|Yes.*No|proceed|permission|confirm"
```

### Approve a prompt

```bash
tmux send-keys -t worker-1 "y" Enter
# Or select a numbered option:
tmux send-keys -t worker-1 "2" Enter
```

### Check all worker sessions at once

```bash
for s in worker-1 worker-2 worker-3 worker-4; do
  echo "=== $s ==="
  tmux capture-pane -t $s -p 2>/dev/null | tail -5
done
```

### Fire-and-forget with result file

```bash
RESULT=/tmp/agent_result.txt
tmux new-session -d -s agentjob -x 220 -y 50
tmux send-keys -t agentjob -l -- "open-code 'Summarise the repo README' > ${RESULT} 2>&1; echo DONE >> ${RESULT}"
sleep 0.1
tmux send-keys -t agentjob Enter
# Poll: grep -c DONE /tmp/agent_result.txt
```

### Parallel tasks with result files

```bash
tmux new-session -d -s parallel -x 200 -y 50
tmux split-window -h -t parallel

tmux send-keys -t parallel:1.0 "task-a && echo DONE > /tmp/a.txt" Enter
tmux send-keys -t parallel:1.1 "task-b && echo DONE > /tmp/b.txt" Enter
# Poll both files for DONE
```

---

## Gotchas

- **Always set `-x / -y`**: without explicit dimensions, headless sessions default to 80×24 which truncates output and breaks TUIs.
- **Shell startup lag**: PowerShell 7 takes 400–1000 ms to show a prompt; `sleep 1` after starting a new session before sending keys.
- **capture-pane lag**: pane output may not be flushed immediately; poll with retries rather than reading once.
- **TUI input**: use `-l --` + separate `Enter` call to avoid multiline/paste parsing bugs in interactive apps.
- **Session cleanup**: tmux sessions persist after shell exit; always `kill-session` or `kill-server` when done.
- **`2>/dev/null`**: use when capturing a session that might not exist yet to suppress errors.
