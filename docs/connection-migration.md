# Roleless Connection storage

Current Project Connection documents use schema version 4. They contain only
Connection identity, display name, platform and transport configuration. The
runtime keeps a version 3 `config/bots.v1.json` untouched and uses a separate
version 4 `config/bots.v1.json.v4` for new Connections. Keep the original in
place so subsequent startups continue using the same version 4 file. No
legacy Connections, credentials, or permissions are imported. A nonempty
version 3 document shows a notice in Connection Settings and produces a startup
warning with the retained file path. Other unsupported versions are still rejected.

Set up Connections using the current authenticated Web Settings and review and
re-publish any required exact BOT inbox bindings; do not
reuse owner proofs or infer BOT mode from a Connection. Recreating a Connection
assigns it a new ID and does not transfer old inbox associations or replay
history. There is no supported automatic transfer in this revision.
