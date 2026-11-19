# Bundled official agent-desktop MCP

Pinned upstream: `vercel-labs/agent-desktop` v1.2.0,
commit `2b0a7334fc111730454b726e6800aa41cdafc093`, Apache-2.0.
The old Rust N-API addon, local upstream patches and Windows input guard are removed.
No Rust/MSVC build or system dependency installer is used by this integration.

Explicit development/release preparation, from repository root:

```
node scripts/download-agent-desktop.ts [platform] [arch]
```

Defaults are the current Node platform/architecture. Supported platforms are
`darwin`, `win32`, `linux`; architectures `x64`, `arm64`. All six official CLI
`.tar.gz` archive hashes and extracted CLI/helper hashes are fixed in `scripts/agent-desktop-lock.json`. Runtime does not trust a mutable manifest to nominate executable hashes. The FFI
archives are not used. Downloads are bounded, hash-checked and staged atomically;
a per-target exclusive lock prevents concurrent installers. Existing invalid
installs are not overwritten. Installation hooks do not fetch/build desktop code.
After verifying no preparation is running, an interrupted `.download-*.lock`
may be explicitly removed before retrying. Never delete another installer's lock.

Assets live in `artifacts/<platform>-<arch>/`:
- official `agent-desktop` (`agent-desktop.exe` on Windows);
- adjacent `agent-desktop-macos-helper` on macOS;
- adjacent `agent-desktop-linux-clipboard-owner` on Linux;
- `manifest.integrity.json` with version/revision/archive identity and file hashes.

Required files must be nonempty regular files with matching hashes, and executable
on Unix. Missing helper, wrong target/version/hash, links or unexpected archive
entries fail closed. Runtime uses an absolute bundled CLI, never PATH, npx, an
addon or a system-installed CLI. Packaging copies only the selected target, its
manifest and legal notices, not session state or source caches.

The runtime starts `agent-desktop --session <host-generated-scope> mcp`, with
private `AGENT_DESKTOP_HOME` and `AGENT_DESKTOP_AGENT_ID`. It uses generic MCP
initialization, discovery, schema validation and provider response adaptation.
There are no custom desktop business tools and no window-bound safety guarantee.
Read [desktop access and recovery](../../docs/computer-use.md) before use.

## Provenance / validation

On 2026-11-05 the six CLI lock hashes matched official `checksums.txt`, itself
verified as SHA-256 `c0dee09958351fcd68b7806427d060829cd2ee3d514625909cd9695dd35e3dd7`.
All six CLI archives were downloaded and matched their fixed SHA-256; their
flat archive contents and extracted CLI/helper hashes were verified. GitHub
attestation verification succeeded for each archive with repository, signer workflow, source digest
and signer digest explicitly constrained:

```
gh attestation verify agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz \
  --repo vercel-labs/agent-desktop \
  --signer-workflow vercel-labs/agent-desktop/.github/workflows/release.yml \
  --source-digest 2b0a7334fc111730454b726e6800aa41cdafc093 \
  --signer-digest 2b0a7334fc111730454b726e6800aa41cdafc093
```

The signed release statement includes all six CLI digests. On macOS arm64, native `--version`
reported `agent-desktop 1.2.0`; initialize/tools-list returned 67 official tools
through both the new transport and the actual managed-source → importer → invoke_tool initialization route (zero tools/call). No tools/call, real desktop action or OS permission
change was performed. Other native targets are not runtime-validated locally;
synthetic integrity/packaging tests cover all six target manifests, including rejection of forged internally consistent file receipts. Native CI/device
lanes remain necessary; do not infer Windows/Linux desktop-operation validation.

See `MCP-MIGRATION.md` for source evidence and the reviewed lifecycle boundary.
