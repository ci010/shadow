# Source, license and integration scope

- Product: https://impeccable.style/
- Repository: https://github.com/pbakaus/impeccable
- Fixed revision: `8409a564d1baee90b2dde4f7a8f06288838e3921`
- Upstream skill version: 4.8.0 (from its SKILL.md metadata).
- License: Apache-2.0; the complete upstream `LICENSE` and `NOTICE.md` are
  reproduced unchanged alongside this file. NOTICE mentions native platform
  references derived from MIT work; those native files are not included here.

## Included and modified files

All adapted source paths below are relative to that revision's
`.agents/skills/impeccable/` directory:

- `SKILL.md`: rewritten as a Shadow entry, retaining the core brief-first,
  refinement-versus-redesign, surface modes and rendered verification concepts.
  Adds Shadow tool discovery, virtual paths, permission/ask rules and micro-app
  integration. Replaces upstream setup and command routing with on-demand topics.
- `reference/setup.md`: adapted from SKILL.md Setup and reference/init.md;
  manual context loading and confirmed PRODUCT.md capture, preserving DESIGN.md;
  omits configuration, binary setup and Live workflow defaults.
- `reference/craft-floor.md`: retains the upstream quality floor and design
  heuristics; removes the assumption that an edit hook is running and softens
  absolute aesthetic bans/font sourcing to respect user constraints and permission.
- `reference/layout.md`, `reference/typeset.md`: retain assessment, application
  and verification guidance; replace binary detector calls with manual review,
  remove Live signature parameters and replace unavailable native/new-work/polish
  links with explicit limitations or Shadow guidance paths.
- `reference/colorize.md`: retains palette/contrast guidance; removes Live
  parameters and replaces unavailable new-work/polish links.
- `reference/mode-operate.md`: retains product-first composition guidance;
  removes the CLI concept-seed preamble.

Every adapted reference carries a modification notice and explicitly subordinates
stylistic prescriptions to user constraints, accessibility and host authorization.
The entry is a deliberate adaptation, not a verbatim copy of the complete skill.

## Not included

Other upstream playbooks (including native platforms, new-work orchestration,
audit/critique automation, generation, hooks and Live Mode), binaries, scripts,
font indices, hook settings, agent definitions and external services are omitted.
No automatic downloads, installation, setup, tool registration, slash-command
registration or service connection occurs. Ask for the design task in ordinary
language and read the appropriate reference; this is not upstream CLI parity.

## Loading and packaging

`src/skills/builtins.ts` scans built-in directories automatically. This package
uses one SKILL.md and plain text resources; no loader or tool changes are needed.
`SkillsManager` and the `v:skills` mount expose the body and on-demand resource
paths, with existing resource containment checks. The backend asset copier in
`scripts/backend-bundle.ts` recursively copies non-code assets, including these
Markdown files and extensionless LICENSE, into the backend distribution. This
is source-bundled guidance, not a user/workspace skill installation.

To update, inspect a new immutable upstream revision, review its license/notices,
compare each included source file, and re-review all executable/setup/tool/ask
instructions before adaptation. Do not copy upstream settings or scripts into
this package. Run `pnpm exec node --import tsx --test src/skills/impeccable-discovery_test.ts`
and the focused backend asset-copy tests after changes.
