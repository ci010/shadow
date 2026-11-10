---
name: auto-dispatch
description: Customize this Project's automatic Work dispatch preferences and inspect its explicit cross-run dispatcher memory.
metadata:
  category: scheduling
---

# Customize automatic Work dispatch

Use this skill when the user wants to adjust how this Project schedules Work,
chooses models or devices, or balances quality, speed, cost and parallelism.
It guides ordinary sessions; the internal dispatcher does not load a skill catalog.

## Project instructions

Read `v:project/dispatch-instructions.md`, then use ordinary `write` to update it.
The virtual file belongs to the current Project regardless of the session's
selected source repository. Do not locate or edit the physical Project Home,
internal agent directory, or the built-in dispatcher definition.

The file supplements the dispatcher's short built-in role; it does not replace
that role. Empty content uses defaults. A single clear preference is sufficient.
For example:

```markdown
Prioritize result quality, then completion time, then model cost.
Use economical models for straightforward, clearly testable changes and stronger
models for complex design and cross-module debugging.
Parallelize independent code tasks in separate workspaces; serialize operations
that share one interactive desktop.
```

Read existing content first. Preserve unrelated preferences and edit only what
the user requested, preferably with an exact `match` replacement. Do not invent
permanent preferences from one failed run or a task-specific exception. Read back
the saved file and summarize the change. Virtual writes support overwrite and
exact replacement, not `flag: "a"` append.

Each automation run creates a fresh dispatcher context and loads the latest
instructions. Changes apply to the next dispatch run, not to workers already
started, and do not themselves enable or immediately run the automation.

## Explicit dispatcher memory

`v:project/dispatch-memory.md` is a separate, persistent working memory file.
The dispatcher may read it next run and update it when cross-run thoughts are
useful. It is not required to write after every run. Empty memory is normal.

Memory can contain tentative scheduling thoughts and things to recheck. It is
not a source of current assignment, execution, dependency or device state;
those facts must be read from Work and execution services. It is not user
instruction, authorization, a second task database or an automatic retry queue.
The dispatcher must recheck old assumptions against current state.

An ordinary session may inspect this memory to explain a scheduling choice, or
edit/clear it when the user asks. Do not clear it as a side effect of changing
preferences. Stable user preferences belong in dispatch-instructions.md, not
in memory. Specific work blockers, results and evidence belong in the Work record.

## Boundaries

Customization does not change a Work's objective, assignee, dependencies or
running worker model. Use the existing Work and automation mechanisms for those
operations. Model and device preferences must use actually available choices;
unsupported execution paths must not silently fall back to another machine.
