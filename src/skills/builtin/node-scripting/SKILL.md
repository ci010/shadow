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
const content = await read({ path: 'README.md' })
const hits = await search({ handler: 'grep', path: 'src', include: '**/*.ts', query: 'TODO' })
console.log(content, hits)
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

## Semantic functions with `infer`

`infer` is an async Node `exec` global, not a registered tool, `invoke_tool`
target, subagent or application SDK. It is available in Node even when the
Project also permits OS shells. It receives only explicitly supplied JSON, not
your session history or tool access, and returns a JSON value checked by the host
against `schema`. Schema validation checks shape, not factual correctness.

```typescript
const evidence = await read({ path: 'notes.txt', offset: 1, limit: 80 })
if (typeof evidence === 'string' && evidence.startsWith('Error:')
    || evidence && typeof evidence === 'object' && evidence.isError) {
  throw new Error('Evidence read failed')
}
const result = await infer({
  instructions: 'Classify whether these notes explicitly describe an unresolved startup failure. Use unknown if evidence is insufficient.',
  input: evidence,
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['failure', 'no_failure', 'unknown'] },
      quote: { type: 'string', maxLength: 300 },
    },
    required: ['status', 'quote'],
    additionalProperties: false,
  },
  maxTokens: 2048,
})
console.log(result) // A judgment about the supplied notes, not proof of runtime behavior.
```

Use ordinary code for parsing, arithmetic and deterministic checks. Use `infer`
for a small semantic classification/extraction inside a useful code pipeline,
not to duplicate the parent's planning or generate approval/test evidence.
Do not use it just because it exists. Handle `unknown` explicitly; self-reported
confidence is not a calibrated probability.

Optional `model` uses normal configured `model@provider` routing, defaulting to
the parent's resolved model. `reasoningEffort` defaults to the parent's effort.
`maxTokens` defaults to 2048, range 32–4096, additionally capped by the parent's
output limit. Request JSON is limited to 64 KiB (schema 16 KiB), returned JSON
to 64 KiB. No tools execute; invalid JSON/schema, unexpected tool calls,
cancellation and provider failures throw without an automatic retry.

The host allows 8 attempts per exec and 2 concurrent, with a 120-second inference
deadline and the enclosing script's cancellation lifecycle. Nested requests
consume the same turn budget as parent-loop requests, leaving one parent
request to inspect the outcome. OTel `script.infer` spans identify the owning
turn/session/exec and record returned token usage, including schema failures.
They are not synthetic assistant-history messages; session history usage alone
does not include these nested calls. Count actual requests, not outer exec calls.
Do not silently catch failures and continue as if the result were valid.

## External programs without an OS shell

Node imports work directly; no extra tool or dependency is needed. Use
`execFile` for bounded output, or `spawn` for streaming. Pass arguments separately,
not as a quoted command string. `exec` and `execSync` invoke an OS shell and are
not alternatives when Runtime permits only Node.

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const { stdout, stderr } = await run('python', ['-c', 'print("ready")'], {
  encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000,
})
console.log(stdout)
if (stderr) console.error(stderr)
```

`execFile` rejects on a nonzero exit; do not swallow that rejection. If you catch
it to print its `stdout`/`stderr`, rethrow it. With `spawn`, handle launch errors
and check the `close` code before claiming success. `execFileSync` also runs a
program directly, but blocks the worker; prefer async calls for concurrent work.
On Windows, `.cmd`/`.bat` launchers need a shell: use a tool's actual executable
or its JavaScript CLI via `process.execPath` instead of silently falling back to
cmd. `python -m pip` likewise avoids a wrapper.

In Node-only mode, nested `exec` tool calls also accept only Node. Do not bypass
this policy by importing a shell launcher. This is a tool-entry policy, not an
OS sandbox: native imports and programs retain host privileges. Keep external
processes owned by the script; use the existing `timeout_ms`/`v:bg`/`cancel`
lifecycle rather than detached, untracked child processes.

## Example — bash-like pipeline

```typescript
// Count TODO-bearing lines in a known set of source files.
const n = await pipe(
  ['src/a.ts', 'src/b.ts'],
  (files) => Promise.all(files.map((path) => read({ path }))),
  (texts) => join(texts),
  (text) => lines(text).filter((l) => l.includes('TODO')),
  count,
)
console.log(`Found ${n} TODOs`)
```

## When to use

- Loops, conditionals, data transformation across several tools
- Short dependent tool chains can avoid parent-model round trips; this does not guarantee lower total cost
- Complex async orchestration (sequential chains, dynamic fan-out, error handling)

## Limits

- All calls share the single `exec` timeout
- A normal outer exec exit does not prove its internal tools succeeded: check returned Error strings and `isError`, and propagate failures.
- Direct-only tools (including blocking subagent calls and decisions) remain direct-only. Composition cannot bypass tool roles, capability checks or dedicated approval boundaries. Work notes are optional context, not execution admission.
- For very long-running parallel tasks, consider `subagent` instead
- Env vars from workspace `.env` are auto-injected into the subprocess
- Use Node.js built-ins (`node:fs/promises`, `node:path`, etc.) for runtime APIs.
- TypeScript runs through Node's native transformer, including enums and parameter properties. JSX and decorators are unsupported. Use explicit extensions for relative imports.

## Shell Safety

- The OS-shell path blocks a small set of destructive patterns (`rm -rf /`, `mkfs.`, etc.); Node source and native imports do not use that filter
- Other dangerous commands are NOT auto-blocked — use judgment
- If a command doesn't finish within `timeout_ms`, it keeps running in the background
