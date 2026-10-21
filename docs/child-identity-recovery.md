# Recovering a preserved Child identity

Do not delete the Child home, protected keys, credential reference or Main registry to repair a configuration mismatch. Do not generate another node ID to bypass a revoked device.

## Local identity repair

Stop pairing attempts first (the repair command does not stop or restart applications). Use the active **Child role** configuration, not a Main configuration or an old `__bootstrap` copy.

From a source checkout:

    node --import tsx src/index.ts child pair --config <absolute-child-config-path> --restore-identity

For a bundled backend, replace `node --import tsx src/index.ts` with its usual executable and backend entry. This command requires no PIN and sends no network request. It validates the credential reference, pairing metadata and existing protected OS key binding before writing anything. It makes an exclusive `*.identity-backup` beside the configuration, then atomically changes only `localNodeId` to the verified preserved identity. It never creates a missing key. If metadata/key bindings disagree, investigate the backup and original home instead of deleting either.

## Main reauthorization

Both Main and Child must run this fix. An older Main rejects the preserved identity because its revocation tombstone still occupies that device/node identity; a fresh invitation alone cannot fix that implementation.

After the reviewed change is committed and published, on each machine's normal checkout:

    git pull --ff-only
    pnpm install --frozen-lockfile
    pnpm desktop

Restart only that machine's Shadow instance using its normal launcher and preserved profile. A service or packaged installation must use its normal build/deployment procedure instead; do not launch a second Main against the same data directory.

On Main, an authenticated administrator creates a fresh invitation and PIN. On Child, retry the normal pairing wizard using the same saved home, endpoint and work folder. Existing credentials now contact Main instead of reporting local-only success. A `credential_not_available` response permits presentation of the same preserved identity with the fresh invitation; network/TLS/other unexpected errors fail closed.

Main accepts a revoked identity into pending only if device ID, node ID, credential ID, fingerprint and public key all match the revoked record exactly. Its tombstone remains revoked across persistence/restart while pending. Main's administrator must compare the fingerprint out of band and explicitly approve. No fresh invitation or local repair automatically restores authorization. Capabilities must be advertised anew after approval.

Verify Main shows Child online; then use a minimal read/list operation in the specifically approved Child work folder. Do not claim remote execution works merely because pairing returned pending. If the remote administrator has not updated Main, supplied a fresh invitation and approved the matching fingerprint, online/workdir verification remains blocked.
