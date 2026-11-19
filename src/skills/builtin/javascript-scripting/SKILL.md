---
name: javascript-scripting
description: "Use bounded inline JavaScript to process data and compose filesystem calls on one resolved Workspace."
---

# Inline JavaScript (`exec`, `shell: "javascript"`)

Use a plain JavaScript ES module for short data transformations or sequences of filesystem operations. Use a direct tool call for one operation. This interface prevents accidental misuse; it is **not a security sandbox**. There are no native imports, `process`, ambient host or Project environment, or external programs.

```javascript
export default async ([path]) => {
  const text = await read({ path })
  return { preview: String(text).slice(0, 200) }
}
```

Pass arguments through the outer `args` array and return bounded JSON. `console.log` and `console.error` provide diagnostic output. Await every tool call; do not start detached work. An uncaught error fails the script.

Call eligible tools as globals, without imports: `await search({ handler: 'grep', path: '.', query: 'example' })`. A tool must be offered to the model for this inference and explicitly support scripting. Compatible static `@shadow/<name>` imports use the same permission checks. Use relative paths for filesystem calls on the outer call's resolved Workspace. Do not pass target selectors, `cwd`, virtual resources or web search. `exec` only runs an authorized OS shell on that target, with an explicit OS shell and positive timeout; no recursive JavaScript or background commands. In JavaScript-only mode the OS command bridge is absent. When offered, `view_edit` can read this session's edit receipts and `sql` can query read-only Project data. Use direct tools for coordination, approvals, convention changes, workspace switches and lazy tool invocation; these cannot be called from scripts.

The computation needs permission to run on Main even when the filesystem target is a Child or LayerFS. The bridge never falls back to Main filesystem on target failure. The timeout is 1–120000 milliseconds; no background mode. Turn cancellation also cancels the worker and revokes its bridge. Cancellation does not roll back completed tool effects.

## Bounded semantic computation

When available, call `await infer({ instructions, input, schema })` directly; `import infer from '@shadow/infer'` still works. This is not a registered tool. Pass only the JSON evidence needed; the provider receives no tools or conversation history. Use ordinary JavaScript for deterministic work. Validate semantic results yourself; schema validation only checks shape. Provider and validation failures reject without automatic retry.

Optional `model`, `reasoningEffort` and `maxTokens` use the parent model settings and output limit by default. Per exec: at most 8 infer attempts, 2 concurrent, subject to the turn's shared budget and the script deadline. Requests, schemas and responses are bounded. The worker also bounds total tool/infer calls.
