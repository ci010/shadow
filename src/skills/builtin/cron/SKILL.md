---
name: cron
description: Guide for scheduling recurring or one-time tasks using cron expressions.
metadata:
  category: scheduling
---

# Cron Scheduling

The `cron` tool is lazy-loaded automatically on its first `invoke_tool` call.

## Tool Contract

Use `invoke_tool` with `name: "cron"` and an `args` object:

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | string | yes | `add`, `list`, or `remove` |
| `id` | string | remove | Job ID |
| `schedule` | string | add | Cron expression or `every 5m` interval |
| `task` | string | add | Prompt delivered when the job fires |
| `session` | string | no | `origin` (default) or `isolated` |
| `once` | boolean | no | Delete after first run |
| `urgency` | string | no | `steering`, `queue`, `debounce`, or `silent`; origin sessions only |
| `debounce_ms` | number | no | Debounce duration when `urgency` is `debounce` |

## Actions

- `add` — schedule a new job
- `list` — list all scheduled jobs
- `remove` — remove a job by ID (ID is returned when you add a job)

## Schedule Formats

- **Cron expression**: `"0 9 * * *"` (daily at 9 AM), `"*/30 * * * *"` (every 30 min)
- **Interval shorthand**: `"every 5m"`, `"every 1h"`, `"every 30s"`
- **One-time**: set `once: "true"` to auto-delete after first run

## Add a Job

```json
{
  "name": "cron",
  "args": {
    "action": "add",
    "schedule": "0 9 * * 1-5",
    "task": "Time for standup!",
    "once": true
  }
}
```

## Session Mode

When a job fires it can run in one of two places, controlled by `session`:

- `origin` (default) — delivers an event into the session that created the job,
  waking up the original conversation.
- `isolated` — runs in a dedicated `cron:<id>` session, keeping recurring work
  out of the originating conversation.

```json
{ "action": "add", "schedule": "every 1h", "task": "Sweep the inbox", "session": "isolated" }
```

## Examples

- Morning briefing: `schedule="0 9 * * *"` task="Give me a morning briefing"
- Hourly check: `schedule="every 1h"` task="Check for new issues"
- One-shot reminder: `schedule="0 14 * * *"` task="Remind about meeting" once="true"
- Background sweep: `schedule="every 30m"` task="Process pending items" session="isolated"
