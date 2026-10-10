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

### Read-only policy requires explicit review

Servers default to untrusted hints. A matching `readOnlyOverrides` rule wins,
including `false`; otherwise `trustReadOnlyHints: true` allows that server's
`annotations.readOnlyHint` to classify a tool. Missing/untrusted hints remain
unknown. Do not enable trust merely to suppress an error or make calls parallel.
Work notes do not gate execution.

Read the exact indexed `v:tools/<server>/<tool-id>` path for `readOnlyPolicy`
(`readOnly`, `source`, `fingerprint`). After reviewing behavior and obtaining
approval, a server entry may contain:

```json
"readOnlyOverrides": {
  "get_record": { "readOnly": true, "fingerprint": "<reviewed 64-character fingerprint>" }
}
```

Keys are exact unprefixed tool names. The fingerprint binds server name, tool
contract/hint, and advertised server version, not private connection settings.
Metadata changes make reviews stale; stale reviews do not fall back to trusted
hints. Re-review and remove/replace overrides when changing connection settings
or implementation even if metadata/version is unchanged. Copying metadata or
trial-running a tool is not verification. Never probe possible writes to establish
read-only status. Credentials are excluded from public fingerprints.

Confirmed reads may share an execution group; unknown or write tools run in
order. Classification never bypasses permissions, allowlists, cancellation or
remote-workdir restrictions.

### Atomic writes

Every write validates the whole document and persists atomically through
`ProjectConfigStore`. If the revision is stale, the write is rejected with a
reread instruction. Read the latest document, preserve concurrent changes,
reapply only the intended edits, and write with its returned revision. Do not
blindly retry the old content or bypass the virtual path by editing application
configuration directly.

## Installation indexes metadata, not tool execution

Before committing configuration, `ProjectConfigStore` indexes missing/new/config-changed
servers using temporary connections and paginated `tools/list`, then closes them.
It never executes tools or retains a runtime connection from installation.
Matching cached records are reused; removal needs no new connection.
Indexing runs in batches of up to three with 60-second per-source timeouts.
If indexing fails, the save aborts: previous configuration and runtime catalog
stay unchanged. An unchanged resave can index legacy configurations missing metadata.

Private, configuration-bound, content-addressed records persist atomically under
Project Home `.mcp-tool-index` before configuration commits, without raw configuration
or credentials. Unreferenced records may remain for rollback; activation rollback
still applies. Report installed/indexed, not guaranteed current availability or
future tool execution. Restart restores the source catalog with zero connections.

To discover indexed metadata, select the configured source:

```js
search({ space: "glob:v:tools/teams", query: "**" })
```

Read the returned individual tool paths for exact names, descriptions,
parameters and `indexedAt` timestamps from the index with zero connections,
`tools/list` RPCs or dynamic registration. Repeated searches work offline; even
100 installed servers will not start from search. Inspect warnings and pagination:
missing, mismatched or corrupt records produce explicit source warnings, never
fallback auto-connections. Read/save MCP configuration to build missing metadata.

Metadata can become stale. Call an exact known ID through `invoke_tool({ name, args })`
only when its operation is intended; invocation can have side effects. Invocation
lazily connects, lists live tools and refreshes the index, then validates the
current schema before execution. The current live invocation contract wins.
Browser/factory sources are not initialized by search either. Use browser_setup
or invocation/preload for explicit initialization.
