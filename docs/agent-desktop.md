# Official agent-desktop integration

The product now uses the complete upstream MCP, not Shadow's former restricted
Windows addon/guard. See [desktop access, privacy and recovery](computer-use.md)
and the [asset preparation/provenance guide](../integrations/agent-desktop/README.md).

Implementation:
- `src/desktop-mcp/service.ts`: host-owned source configuration, permission binding,
  host-wide FIFO, unknown-outcome blocking and generic MCP connection subclass.
- `src/desktop-mcp/transport.ts`: official newline JSON stdio, cancellation delivery,
  bounded direct-child EOF/TERM/KILL cleanup; no process-name or cross-session kills.
- `src/tools/load-tool.ts`, `src/mcp/client.ts`, `src/mcp/adapter.ts`: reusable managed
  source hooks, official schema discovery and text/structuredContent/image delivery.
- `scripts/agent-desktop-lock.json`, `scripts/download-agent-desktop.ts`,
  `scripts/agent-desktop-integrity.ts`, `scripts/agent-desktop-assets.ts`: six fixed
  CLI archives, exclusive/atomic preparation, mandatory adjacent helpers and packaging.

Focused tests (no desktop operations):

```
node --import tsx --test src/desktop-mcp/*_test.ts scripts/agent-desktop-assets_test.ts scripts/download-agent-desktop_test.ts scripts/agent-desktop-ownership_test.ts
node --import tsx --test src/mcp/*_test.ts src/tools/load-tool_test.ts scripts/postinstall-native_test.ts scripts/release-workflow_test.ts scripts/release-manifest_test.ts
```

Native macOS arm64 validation was limited to a verified CLI version and MCP
initialize/tools-list (67 tools). Other native targets, actual desktop effects,
clipboard behavior and permission prompts need separately authorized native tests.
This integration does not promise all descendant helpers are forcibly terminated.
Intended launched apps/clipboard ownership are not undone at MCP disconnect.
