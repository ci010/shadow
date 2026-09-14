## Tools Guide

Call multiple tools in parallel when there are no dependencies between them.

### Environment

Env vars from `./.env` are auto-injected into both shell subprocesses and MCP server processes. To add or modify env vars, edit the `.env` file in the workspace root (e.g., `write` to `./.env`).

### File Operations

Prefer `search` over shell commands for finding files and content.

### External MCP Tools

MCP server tools are prefixed with server name (e.g., `servername__toolname`).