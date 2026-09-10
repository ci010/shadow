---
name: node-scripting
description: "Advanced exec shell:node scripting — tool bridge, pipe helpers, inline TypeScript orchestration. Load this skill when using exec with shell: 'node' for multi-step tool chaining."
metadata:
  core: true
---

# Advanced Node.js Scripting (`exec` with `shell: 'node'`)

Use `exec` with `shell: 'node'` for short TypeScript-based orchestration when plain tool calls would be too chatty or sequential. Prefer it for loops, conditionals, transformations, and complex async flow control (sequential chains, dynamic fan-out, error handling across steps).

## Tool Bridge

All session tools are injected as callable functions — call them directly by name, just like regular functions. It works for both **Inline scripts** and **Module scripts**. No imports needed.

```typescript
// Tool functions and helpers are auto-available. No imports needed.
const content = await read_file({ path: 'README.md' })
const hits = await grep({ pattern: 'TODO', path: 'src' })
console.log(content.length, hits)
```

## Pipe Helpers

Concise data-flow combinators available in `shell: 'node'` scripts:

| Helper Signature           | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `pipe(val, fn1, fn2, ...)` | Chain async transforms (like Unix `\|`)           |
| `json(str)`                | Parse JSON string; pass-through if already object |
| `lines(str)`               | Split string into non-empty lines                 |
| `pick(obj, key)`           | Extract a field                                   |
| `flat(arr)`                | Flatten one level                                 |
| `join(arr, sep?)`          | Join into string (default `\n`)                   |
| `count(arr\|str)`          | Length of array or string                         |

Use native JS `arr.map()` and `arr.filter()` directly — no wrapper needed.

## Example — bash-like pipeline

```typescript
// Find all TODOs across .ts files (equivalent to: glob **/*.ts | xargs grep TODO | wc -l)
const n = await pipe(
  glob({ pattern: '**/*.ts' }),
  (files) => Promise.all(files.map((f) => read_file({ path: f }))),
  (texts) => join(texts),
  (text) => lines(text).filter((l) => l.includes('TODO')),
  count,
)
console.log(`Found ${n} TODOs`)
```

## When to use

- Loops, conditionals, data transformation across several tools
- A single script that chains 5 tool calls is faster than 5 separate tool invocations
- Complex async orchestration (sequential chains, dynamic fan-out, error handling)

## Limits

- All calls share the single `exec` timeout
- For very long-running parallel tasks, consider `subagent` instead
- Env vars from workspace `.env` are auto-injected into the subprocess
- Use Node.js built-ins (`node:fs/promises`, `node:path`, etc.) for runtime APIs.
- TypeScript runs through Node's native transformer, including enums and parameter properties. JSX and decorators are unsupported. Use explicit extensions for relative imports.

## Shell Safety

- A small set of destructive patterns (`rm -rf /`, `mkfs.`, etc.) are blocked
- Other dangerous commands are NOT auto-blocked — use judgment
- If a command doesn't finish within `timeout_ms`, it keeps running in the background
