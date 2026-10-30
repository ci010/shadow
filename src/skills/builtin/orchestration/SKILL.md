---
name: orchestration
description: "Design complex parallel work with agent teams, distinct scopes and integration risks."
metadata:
  category: tools
---

# Complex parallel work

Use this when a substantial effort has several owners, uncertain decomposition,
shared interfaces or integration risks. It is not a prerequisite for ordinary
task/call delegation and not a new teams runtime or grant of capabilities.
The current execution contract and live tool schemas remain authoritative.

## Choose a decomposition

Define the user outcome and observable acceptance criteria before assigning work.
Split by independently verifiable outcomes or owned domains, not arbitrary agent
count. For each scope, identify inputs, expected output, explicit file/domain
ownership, dependencies, shared interfaces, verification evidence and the point
where work must stop or return for a decision.

Do not create separate explore, implement and verify workers unless each adds
value. Prefer one coherent owner when splitting would create more coordination
than useful parallelism.

## Stabilize before parallelizing

Identify shared contracts, composition files and migration boundaries. Resolve
the minimum interface needed for independent progress. If that cannot be done
safely, serialize the dependent work instead of assigning overlapping changes
and hoping to merge them later.

Use parallelism for independent scopes. Keep tightly coupled edits under one
owner or an explicit sequence. Before taking over active work, wait for completion
or confirmed cancellation, then reread files and account for partial side effects.

## Choose the collaboration shape

Use task/call for bounded assignments; their basic operation is covered by the
system guidance and live tool contracts, with no additional skill prerequisite.
Use durable peers only when reusable context or ongoing responsibility is
valuable; then read `v:skills/peer-sessions` directly.

Use Work only when dependencies, ownership or recovery needs justify a durable
goal map; then read `v:skills/work-coordination` directly. Do not create peers and
Work branches merely to make the effort look organized. Do not load both scenario
skills unless both mechanisms are needed.

## Integrate and verify

Name the integration owner and define the evidence required from each scope.
Keep useful independent work moving while dependencies run.

At integration, inspect actual changes and test the combined behavior. Worker
confidence, isolated tests and successful execution are not proof that the user
outcome works end to end. Use structured task review when required by the contract.

When a dependency fails or a premise changes, revise the affected plan. Do not
blindly replay assignments or continue downstream on an invalid assumption.

Close with the achieved outcome, verification evidence, remaining risks and
required decisions—not a narration of agent activity.
