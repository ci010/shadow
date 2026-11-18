---
name: answer-data
description: "Show a small computed table or native line/bar chart in Shadow web chat without transcribing tool values."
metadata:
  category: tools
---

Use a foreground `exec` call with `shell: "node"` and a positive timeout.
Compute the display rows in the script and return `{ answerData: { kind, title,
columns, rows } }` from its default export. For example, inside the function:

```js
return { answerData: { kind: 'bar', title: 'Orders by month',
  columns: ['Month', 'Orders'], rows: aggregated.map(r => [r.month, r.count]) } }
```

Use `kind: 'line'` for ordered trends, `'bar'` for category comparisons, or
`'table'` for exact inspection. Charts have one category and one numeric column
(|value| ≤ 1e15), in supplied row order. Tables accept up to eight columns;
cells are plain strings, finite numbers, booleans or null. Use 1–40 rows,
strings of at most 160 UTF-16 code units, and a display payload up to 12 KiB
(UTF-8). No HTML, URLs, paths, or executable chart configuration are resolved.

In the same turn, put the following exact, standalone fence **at the end** of
your final answer (after ordinary conclusion or caveat prose):

````markdown
```answer-data
latest
```
````

The reference resolves only the latest valid display projection from this turn.
Do not paste any data, IDs, paths, or URLs into the fence. The chart or table
renders in the answer, including after reload. For other channels or when
local Node execution is unavailable, use ordinary Markdown/text without this
reference. This does not save raw inputs; don't embed confidential inputs in
tool arguments or print them. Other tool calls retain their own ordinary
history, so perform the read/transform in the same script when practical.
