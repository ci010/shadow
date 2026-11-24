# Roleless Connection storage

Current Project Connection documents use schema version 4. They contain only
Connection identity, display name, platform and transport configuration. The
runtime rejects older documents instead of migrating or rewriting them.

Back up older documents before changing them. Set up Connections using the
current authenticated Web controls and publish exact BOT inbox bindings; do not
reuse owner proofs or infer BOT mode from a Connection. Recreating a Connection
assigns it a new ID and does not transfer old inbox associations or replay
history. There is no supported automatic transfer in this revision.
