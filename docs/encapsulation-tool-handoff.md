# Experimental learning-outcome triage tool handoff

Status (2026-11-05): **draft only; not installed, not registered, no grants**.
Discoverable repository handoff, not a Project skill or evidence of live usefulness.
Trigger: repeated review of encapsulator outcomes where execution success and
artifact usefulness have been conflated. This pure helper highlights review
items; it cannot judge skill quality, discover files or acknowledge learning.

## Exact tested source: learning-outcome-triage.ts

```ts
export async function run(args) {
  const rows = args.runs;
  const counts = {applied:0,no_change:0,blocked:0,partial:0,draft_only:0};
  const issues = [];
  for (const [i,r] of rows.entries()) {
    if (!(r.status in counts)) throw new Error('Unknown learning status');
    counts[r.status]++;
    if (r.status === 'applied' && r.artifacts === 0) issues.push({index:i,kind:'missing_artifact'});
    if (r.status === 'no_change' && !r.reason.trim()) issues.push({index:i,kind:'missing_reason'});
    if (r.unresolvedErrors > 0) issues.push({index:i,kind:'unresolved_error'});
  }
  return {runs:rows.length,counts,noChangeRatio:rows.length ? counts.no_change/rows.length : null,issues,limitation:'Counts are triage only; inspect source, skill discovery and real usefulness separately.'};
}
```

## Schema and synthetic cases

Invoke the existing `agent_tool_test` with the exact source above,
`source: "learning-outcome-triage.ts"`, `grants: []`, `imports: []`,
`allowedModules: []`, and this parameter schema:

```json
{"type":"object","properties":{"runs":{"type":"array","items":{"type":"object","properties":{"status":{"type":"string"},"artifacts":{"type":"integer","minimum":0},"reason":{"type":"string"},"unresolvedErrors":{"type":"integer","minimum":0}},"required":["status","artifacts","reason","unresolvedErrors"],"additionalProperties":false}}},"required":["runs"],"additionalProperties":false}
```

Cases (`capabilityResults: {}`; all expected objects include
`limitation: "Counts are triage only; inspect source, skill discovery and real usefulness separately."`):

1. `flags false applied, empty no-change rationale and unresolved errors`
   - args: `{"runs":[{"status":"applied","artifacts":0,"reason":"done","unresolvedErrors":0},{"status":"no_change","artifacts":0,"reason":" ","unresolvedErrors":1}]}`
   - expected: `{"runs":2,"counts":{"applied":1,"no_change":1,"blocked":0,"partial":0,"draft_only":0},"noChangeRatio":0.5,"issues":[{"index":0,"kind":"missing_artifact"},{"index":1,"kind":"missing_reason"},{"index":1,"kind":"unresolved_error"}]}` plus limitation above.
2. `empty window is not success`
   - args: `{"runs":[]}`
   - expected: `{"runs":0,"counts":{"applied":0,"no_change":0,"blocked":0,"partial":0,"draft_only":0},"noChangeRatio":null,"issues":[]}` plus limitation above.

Actual runtime `agent_tool_test` invocation in task `general-1aab596744314155`
returned `synthetic:true`, `passed:true`, both cases passed, no capability calls;
source hash `sha256:f6ab231915aea8da3bccf95a6501541ef77dcdd367def8ccb871a4139cf2ff22`.
Mock-only execution does not verify live permissions or delivery. This helper's
`applied` artifact check is intended for encapsulation review, not reflector
receipts where logs alone can be legitimate effects.

## Authoring/review handoff

Before executable publication: use the existing shared skill authoring route,
review the exact source/schema and resource scope, add invalid-status and large
input limits/cases, choose the skill-relative module adapter required by the
current skill-tool contract, test again, then activate the exact saved skill and
invoke its tool. `run(args)` test source is not itself a registered skill tool.
Do not add filesystem/network imports to automate ledger access. A reviewer
supplies bounded sanitized rows through the supported runtime and separately
inspects source evidence, discoverability, tool activation and user-facing value.
Retire this draft if repeated reviews do not benefit from its triage output.

## Second-pass review boundary (2026-11-07)

This draft is unchanged and remains uninstalled; no new synthetic/live run or
publication was performed in the second pass. Candidate selection no longer
requires proven high frequency: a concrete costly/error-prone bounded step and a
falsifiable usefulness test can justify a small experiment. That is not a quota
to produce pure-transform helpers, nor permission to access runtime/ledger files.
Do not inflate this triage draft into evidence that the actual oversized skill
maintenance or parked-batch recovery was solved. Those fixes, preflight limits,
verified-store fixture and owner-only recovery handoff are documented in
[encapsulation automation](encapsulation-automation.md#second-pass-bounded-maintenance-and-observed-recovery-2026-11-07).
