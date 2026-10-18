---
name: answer-flow
description: "Draw native inline Vue Flow diagrams in web answers: architecture, network/process boundaries, dependencies and lifecycle flows. Declarative answer-flow JSON, no iframe, app or executable Vue."
metadata:
  category: tools
---

# Native Vue Flow answers

Use this for relationships that benefit from actual nodes and edges: architecture,
network paths, process boundaries, dependencies or lifecycle sequences. This is a
native block in a web reply, not an app build. No tools, server, iframe, Vue source
or separate artifact are needed. Pair the diagram with ordinary Markdown for
conclusions and caveats. Use answer-html for prose layouts/cards instead.

Only Shadow web answers advertise this renderer. For other channels use ordinary
Markdown/text. The fence is `answer-flow`, containing strict JSON (no comments,
trailing commas, JS expressions or Markdown inside labels).

## Basic example

```answer-flow
{
  "version": 1,
  "title": "Control, game and data paths",
  "summary": "Control passes through API and SSH; game traffic goes directly to the host. Public game ingress remains unverified.",
  "direction": "TB",
  "height": 400,
  "nodes": [
    {"id":"client","label":"User device"},
    {"id":"api","label":"Control platform","detail":"Owns accepted business state and lifecycle decisions."},
    {"id":"host","label":"Game host","detail":"Helper, watchdog and Minecraft provide host execution observations."},
    {"id":"store","label":"Object storage","detail":"Immutable snapshot bytes, not the canonical pointer."}
  ],
  "edges": [
    {"source":"client","target":"api","label":"HTTPS · control"},
    {"source":"api","target":"host","label":"SSH · management"},
    {"source":"client","target":"host","label":"TCP · game","status":"unverified"},
    {"source":"host","target":"store","label":"HTTPS · snapshots"}
  ]
}
```

## Protocol

Root fields (unknown fields are invalid):

- `version`: required, exactly `1`.
- `title`, `summary`: optional plain text. Summary should explain the essential
  relationship in words, including any material uncertainty.
- `direction`: optional `TB` (top to bottom, default) or `LR` (left to right).
- `height`: optional integer 240–640 pixels; default 400. Do not enlarge a canvas
  to hold an entire essay. Split large explanations into several diagrams.
- `layout`: optional `{ "mode": "auto" }` (default) or `{ "mode": "relative" }`.
- `nodes`: required array of `{id,label,detail?,status?,group?,placement?}`.
- `edges`: required array of `{source,target,label?,status?}`.
- `groups`: optional array of `{id,label}` defining visual boundary containers.

Node IDs must be unique, as must group IDs; these are separate namespaces. Every
edge must reference existing node IDs; every node `group` must reference an
existing group. A group denotes a visual boundary, not automatic proof of OS,
network, security or authorization isolation. Group membership is one level;
groups cannot contain groups.

Node and edge `status` may be `implemented`, `proposed` or `unverified`. Omit it
when not applicable. Never label something implemented because a diagram looks
finished. Treat status as an evidence claim, not decoration.

Bounds: source 64 KiB; 60 nodes, 120 edges, 12 groups. IDs up to 64 characters;
labels/title up to 160 characters; detail/summary up to 2,000 characters. Keep
normal answers much smaller (roughly 4–12 nodes per diagram). Text is rendered
literally: HTML, Markdown, URLs, Vue templates, callbacks and code are not an
extension mechanism. Do not add pixel coordinates, node types, CSS, event handlers,
actions or arbitrary Vue Flow options.

## Relative placement

For intentional ordering use `layout:{"mode":"relative"}` and give **every** node
`placement:{"row":0,"column":0}`. Both values must be integers from 0 through 20.
Rows increase downward and columns rightward regardless of `direction`. Cells are
local to each group; all ungrouped nodes share a separate local grid. Two nodes
in the same group (including the ungrouped grid) cannot occupy the same cell.
Groups remain non-overlapping lanes: side by side for TB, stacked for LR, in
`groups` order, then the ungrouped lane. The renderer computes fixed spacing,
padding and group bounds; edges do not override placement. Sparse cells leave
gaps. Missing placement is invalid in relative mode; placement is invalid in
explicit or default auto mode. Auto retains cycle-safe TB/LR edge layering.
Only grid cells are supported, never `position`, x/y, absolute/free modes, sizing
or arbitrary Vue Flow options. Fit includes the whole diagram, also on mobile.

```answer-flow
{
  "version":1,
  "title":"Relative review path",
  "layout":{"mode":"relative"},
  "nodes":[
    {"id":"review","label":"Review","placement":{"row":0,"column":1}},
    {"id":"evidence","label":"Evidence","placement":{"row":1,"column":0}},
    {"id":"decision","label":"Decision","placement":{"row":1,"column":2}}
  ],
  "edges":[{"source":"evidence","target":"review"},{"source":"review","target":"decision"}]
}
```

## Group example

```answer-flow
{
  "version":1,
  "title":"Game-host process boundaries",
  "summary":"The short SSH entry is separate from persistent supervision and the restricted workload.",
  "direction":"LR",
  "groups":[
    {"id":"management","label":"Protected management"},
    {"id":"workload","label":"Restricted workload"}
  ],
  "nodes":[
    {"id":"ssh","label":"sshd → helper CLI","group":"management"},
    {"id":"watchdog","label":"Watchdog","group":"management","detail":"Enforces finite authorization offline; does not publish worlds."},
    {"id":"runner","label":"Runner","group":"workload"},
    {"id":"java","label":"Java / Minecraft","group":"workload"}
  ],
  "edges":[
    {"source":"ssh","target":"runner","label":"Submit persistent operation"},
    {"source":"watchdog","target":"runner","label":"Supervise deadline"},
    {"source":"runner","target":"java","label":"Launch / observe"}
  ]
}
```

## What the platform does

The platform validates the data, computes layout, applies the current theme and
renders read-only Vue Flow. Users can pan, zoom, fit the graph and inspect node
details. Mouse wheel over the canvas zooms (without scrolling the page); outside
the canvas the conversation scrolls normally. Drag pans; zoom buttons and Fit
remain available. They cannot edit topology or trigger business actions. Each block has
independent state. A text representation remains available for accessibility,
search and copying. Incomplete streaming JSON or invalid input produces a
readable fallback rather than executing partially formed content.

Do not calculate pixel coordinates. Do not inject Vue components into answer-html
or produce a whole Vue project merely to show a diagram. Essential conclusions
belong in visible Markdown, not only in a node detail panel.

## Viewport transitions

Vue Flow reference: https://vueflow.dev/examples/transition.html . This concerns
smooth viewport movement (e.g. focus/fit), not business-state transitions. It is
optional presentation inspiration, not an additional authoring API. The protocol
does not accept transition code, durations, animation callbacks or arbitrary
Vue Flow props. Do not promise animated tours. Any future host-provided motion
should respect reduced-motion preferences.
