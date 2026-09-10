---
name: coding
description: General coding assistance — TypeScript, Deno, and Node.js conventions, file operation best practices, and code review guidance.
metadata:
  core: true
---

# Coding

## TypeScript / Deno Conventions

- Strict TypeScript with explicit types on function signatures
- Prefer `interface` over `type` for object shapes
- Use `import type` for type-only imports
- Prefer async/await over raw Promises
- Use const assertions and narrowing where appropriate

## File Operations

- Always read a file before modifying it — understand context first
- Use `write(match="...", content="...")` for targeted find-and-replace changes
- Use `write(path="...", content="...")` for new files or complete rewrites
- Verify changes by reading the file after editing

## Code Review Checklist

- Type safety: check for `any`, unchecked casts, missing null guards
- Error handling: ensure errors are caught or propagated meaningfully
- Imports: correct paths, no unused imports, type-only imports where applicable
- Side effects: watch for unintended mutation, leaked state, or race conditions
