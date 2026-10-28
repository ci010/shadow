# Setup and product context — Shadow adaptation

Adapted from upstream SKILL.md Setup and reference/init.md at the revision in
`v:skills/impeccable/UPSTREAM.md`. This is the manual context/init path, not the
upstream CLI, hook, Live Mode or configuration workflow.

## 1. Load context before design work

Apply only to a UI/design task. Do not initialize product records for backend-only
work or merely because this skill was discovered. Do not run `impeccable context`:
this edition bundles no launcher. State when relevant that context was loaded
manually, not by the upstream executable.

Read applicable repository instructions, the target implementation, existing
PRODUCT.md and DESIGN.md in the owning project/app scope, and any explicitly
identified public surface brief. Use permitted file discovery to locate existing
records before inventing paths. Root context may be inherited by a child app:
confirm shared versus app-specific authority before writing a competing record.
Do not inspect private configs, credentials or runtime data to emulate setup.

PRODUCT.md records durable product truth. DESIGN.md records the visual system.
An existing coherent UI or DESIGN.md is evidence of an incumbent identity even
when PRODUCT.md is absent. Inspect real tokens, components, routes, copy and
assets to resolve scope. For Shadow itself, read the root DESIGN.md (Quiet
Workbench), preserve its tokens/components and verify against app source; do not
replace that system with the generic craft-floor examples.

## 2. Route by the actual request

- Narrow refinement/review: use existing product and design evidence, ask only
  about material gaps; do not block on a missing PRODUCT.md or bootstrap a new
  identity. Offer durable context capture only if it would help future work.
- New surface or explicitly requested replacement visual world: resolve product
  truth before visual direction. If PRODUCT.md is missing, use the init flow below
  within the authorized writing scope; do not silently skip required context.
- Explicit init/context-capture request: capture or update PRODUCT.md, then resume
  the original task. Init does not create, replace or offer DESIGN.md just because
  it is missing, and does not choose typography, palette or a visual world.
- Existing PRODUCT.md: preserve confirmed fields; ask what is stale or missing
  only when relevant. Add durable facts rather than reopening the whole brief.
- Only DESIGN.md exists: preserve it. Missing product truth is not license to
  overwrite the design system or regenerate its sidecar.

## 3. Init: explore, confirm, record

Before asking, inspect public project docs and copy, app boundaries, features,
workflows, roles, product name/assets, platform/accessibility signals and relevant
build constraints. Evidence is a hypothesis, not user approval. Ask only material
unanswered questions with `ask(kind=input)` and wait; do not substitute silence
for a response. Ask about users/jobs/context, the product's purpose/mechanism,
and durable constraints or evidence. Use small rounds (at most three focused
questions); do not demand every optional field. Confirm important inferences
before writing a new product record. If answers cannot be obtained, report the
missing facts and pause context capture; do not fabricate completion.

Platform may be web, ios, android or adaptive; mobile web and a web wrapper are
not automatically native. Confirm ambiguity. If a truly greenfield build has no
stack, resolve the stack/deployment choice at the appropriate decision boundary
with `ask(kind=decision)`; a recommendation is not a recorded user choice.
Use the host's decision flow as well for consequential scope/write permission.
Plain product answers do not authorize unrelated file writes or services.

Write only when the task authorizes that output. Prefer updating the existing
resolved PRODUCT.md; never silently overwrite it, create a competing authority,
or alter DESIGN.md as part of init. Preserve useful legacy headings. For a new
record in the confirmed project root, use this minimal schema, adding only
relevant confirmed sections and explicitly marking open decisions:

```markdown
# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
[Confirmed users, context and jobs.]

## Product Purpose
[Confirmed purpose, mechanism and success.]

## Capabilities and Constraints
[Confirmed scope, terminology and explicitly undecided facts.]
```

Optional sections: Stack (greenfield answer/delegation only), Positioning,
Operating Context, Brand Commitments, Evidence on Hand, Product Principles,
Accessibility & Inclusion. Never invent customers, testimonials, pricing,
benchmarks, licensing or deployment claims. Preserve binding volunteered visual
constraints without turning init into an aesthetic interview.

Verify the saved PRODUCT.md exists at the intended path and contains the
confirmed record before calling an authorized init complete. Interview notes or
later design prose do not replace the file. Summarize captured and deliberately
undecided facts, then resume the originating task without rerunning setup.

## Explicit omissions

No `.impeccable/config.json`, local config, live config, hooks, CSP changes,
image-generation buildPath setting, detector sidecar or design.json is created,
repaired or migrated by this flow. No default is inferred from silence. Native
platform references are not bundled; use the project's platform guidance and
report that limitation. Upstream command aliases/decision-page controls are not
Shadow commands. Context reading and a skill read alone grant no execution,
publication or external-service permission.
