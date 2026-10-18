---
name: cron
description: Guide for scheduling recurring or one-time tasks using cron expressions.
metadata:
  category: scheduling
---

# Cron Scheduling

Use `search(query="**", handler="glob", path="v:tools/cron")` to discover scheduling tools;
read their returned paths for complete contracts.
Invoke `cron_add`, `cron_list`, or `cron_remove` through `invoke_tool`.
No separate import or `action` argument is required. Arguments are validated
before execution. Discovery never adds or removes a job.

## Tool Contract

Use `invoke_tool({name: "cron_add", args: {...}})` to schedule a task:

| Field | Type | Required | Notes |
|---|---|---|---|
| `schedule` | string | yes | Cron expression or `every 5m` interval |
| `task` | string | yes | Prompt delivered when the job fires |
| `session` | string | no | `existing` (default) or `fresh` |
| `targetSessionId` | string | no | Existing durable session in this Project; existing mode only, defaults to current session |
| `name` | string | no | Readable job name; defaults to the task |
| `agentType` | string | no | Agent type for fresh runs, default `general` |
| `once` | boolean | no | Delete after first run |
| `urgency` | string | no | `steering`, `next-step`, `queue`, `debounce`, or `silent`; existing mode only. `next-step` joins the next inference without aborting an active request or tool. |
| `debounce_ms` | number | no | Debounce duration when `urgency` is `debounce` |

## List and Remove

- `invoke_tool({name: "cron_list", args: {}})` lists scheduled jobs in this Project.
- `invoke_tool({name: "cron_remove", args: {id: "<job ID>"}})` removes a job,
  retaining session history. Use an ID returned by `cron_add` or `cron_list`.

## Schedule Formats

- **Cron expression**: `"0 9 * * *"` (daily at 9 AM), `"*/30 * * * *"` (every 30 min)
- **Interval shorthand**: `"every 5m"`, `"every 1h"`, `"every 30s"`
- **One-time**: set `once: true` to auto-delete after first run

## Add a Job

```json
{
  "name": "cron_add",
  "args": {
    "schedule": "0 9 * * 1-5",
    "task": "Time for standup!",
    "once": true
  }
}
```

## Session Mode

When a job fires it can run in one of two places, controlled by `session`:

- `existing` (default) — delivers an event to `targetSessionId`, or the current
  session when omitted. It keeps that conversation's history and configuration.
- `fresh` — starts a new independent session for every run, using `agentType`
  (default `general`). It inherits the creator's workdir reference, not its
  conversation. Runs appear under Automations.

For recurring work in its own long-lived conversation, create a topic first,
then use its returned session ID as `targetSessionId`. Source and target must
be durable sessions in this Project; scheduling a peer requires messaging
permission. The target executes with its own tools and permissions. Access is
rechecked on each tick; a missing target is not automatically recreated.
Do not pass `targetSessionId`, `urgency` or `debounce_ms` for fresh runs.
The former `origin`/`isolated` modes and `isolated` boolean are not supported.

```json
{
  "name": "cron_add",
  "args": {
    "schedule": "every 1h",
    "task": "Sweep the inbox",
    "session": "existing",
    "targetSessionId": "<session ID returned by topic>"
  }
}
```

## Examples

- Morning briefing: `schedule="0 9 * * *"` task="Give me a morning briefing"
- Hourly check: `schedule="every 1h"` task="Check for new issues"
- One-shot reminder: `schedule="0 14 * * *"` task="Remind about meeting" once="true"
- Background sweep with retained context: `schedule="every 30m"` task="Process pending items" session="existing" targetSessionId="<existing topic ID>"
- Independent check: `schedule="every 1h"` task="Check service health" session="fresh" name="Service health"
