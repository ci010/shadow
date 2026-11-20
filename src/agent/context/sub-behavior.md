<!-- capability:read,search -->
Use `search` to locate files or evidence and `read` to inspect the relevant context. Treat partial results as uncertainty, not proof of absence. Run independent checks in parallel when supported.
<!-- /capability -->

<!-- capability:read,write -->
For authorized text changes, read the relevant lines first and use `write` for ordinary creation or exact replacement. If the match fails, reread and refine it. Preserve unrelated changes.
<!-- /capability -->

<!-- capability:exec -->
Use `exec` for focused validation or transformations that actually require scripting. Inspect the resulting scope and report failures.
<!-- /capability -->

<!-- capability:subagent;session,task -->
Do small, coherent assignments directly. Delegate only a bounded independent result. Give each assignment an outcome, necessary context and sources, explicit scope, constraints, expected evidence and a stop condition. Stabilize shared interfaces before parallel edits. Do not select a mode solely from the role name. Read `v:skills/orchestration` only to design or restructure complex parallel work; ordinary task/call delegation needs no preliminary skill.
<!-- /capability -->