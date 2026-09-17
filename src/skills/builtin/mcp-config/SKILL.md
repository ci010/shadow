---
name: mcp-config
description: Configure, update, or remove persistent MCP servers in the current Project using the virtual MCP configuration document.
metadata:
  category: setup
---

# Configure Project MCP servers

Use existing `read` and `write` tools on `v:config/mcp.json`. Do not edit
application configuration or source files, run an installation/import tool, or
create session-only MCP registrations. Changes persist in the current Project.

## Read before editing

```js
read({ path: "v:config/mcp.json" })
```

The JSON document contains `revision` and `mcpServers`. The revision is opaque:
retain exactly the value returned by the read. Secret values are redacted as
placeholders. Keep unchanged placeholders exactly as returned to preserve
their stored values; do not invent, move, or substitute placeholders for new
credentials. Do not ask users to paste credentials into chat or expose them
in reports.

## Add or update servers

Edit the returned `mcpServers` map, retaining unrelated entries and placeholders.
Each key is a server name. Stdio entries use `command`, CLI `args`, and optional
`env`. HTTP entries use `type: "streamable-http"`, `url`, and optional `headers`.
Configured headers do not automate OAuth login.

For example, this batch adds a stdio server and an HTTP server in one write:

```js
write({
  path: "v:config/mcp.json",
  content: JSON.stringify({
    revision: "<opaque revision from the read>",
    mcpServers: {
      // Include every existing entry that should remain.
      teams: {
        command: "agency",
        args: ["mcp", "teams"]
      },
      reports: {
        type: "streamable-http",
        url: "https://mcp.example.com/mcp"
      }
    }
  })
})
```

Use the actual revision and approved commands/endpoints, not these illustrative
values. `write` takes a `path` and string `content`; submit the complete edited
JSON document without `match` or append `flag` for whole-document replacement.
The comments above are outside the serialized JSON. Several additions, edits,
and removals can share one write.

Alternatively, after reading the document in the same logical and physical
session, use `match` for an exact edit of that remembered redacted snapshot:

```js
write({
  path: "v:config/mcp.json",
  match: "https://mcp.example.com/mcp",
  content: "https://mcp.example.com/v2/mcp"
})
```

Use actual exact text from the read. Optional `flag: "g"` replaces all matches;
omit it for a single replacement. These are `match`/`content` edits, not
`old_str`/`new_str`. Edits require a prior read in the same logical and physical
session and still undergo revision checking. If no usable snapshot exists,
reread instead of retrying blindly. Whole-document overwrite must explicitly
include the revision; exact edits retain it from the remembered snapshot.

To update a server, change only its intended fields in the map. To remove one,
remove its key and preserve the other entries. An empty `mcpServers` map removes
all configured entries; use it only when that complete removal is intended.

## Concurrency and validation

Every write validates the whole document and persists atomically through
`ProjectConfigStore`. If the revision is stale, the write is rejected with a
reread instruction. Read the latest document, preserve concurrent changes,
reapply only the intended edits, and write with its returned revision. Do not
blindly retry the old content or bypass the virtual path by editing application
configuration directly.

## Saved configuration is not a live connection

A successful write updates the catalog only. It performs no handshake, starts
no MCP connection, and calls no MCP tools. Report configuration saved, not
connection verified.

When live discovery is intended, select the configured source:

```js
search({ space: "tools:teams", query: "" })
```

This connects lazily and discovers schemas without invoking tools. Inspect
errors and pagination before claiming discovery succeeded. Call an exact
discovered ID through `invoke_tool({ name, args })` only when its operation is
intended; invocation can have side effects. Configuration persistence does not
guarantee installed executables, valid credentials, reachable endpoints, or a
successful tool call.
