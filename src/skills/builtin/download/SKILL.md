---
name: download
description: "Use Shadow's pinned, bundled aria2c for user-approved, resumable HTTPS downloads; select trusted revisions, verify SHA-256 and reuse existing caches before downloading."
core: true
metadata:
  category: tools
---

# Verified, resumable downloads

Shadow bundles a pinned `aria2c` with the desktop application; it does not
silently use the system `PATH`. Use `download` through `invoke_tool` (find its
contract with `search(query="download", space="grep:v:tools")`). Run
`download status` to check the binary and version. Source and built backends
running from a repository checkout use `desktop/aria2/aria2c` (`aria2c.exe`
on Windows); these development assets are not downloaded at startup.
A missing or different version in an installed app is a packaging error;
do not silently run another binary.
Local development can also set the absolute
`SHADOW_ARIA2C_PATH` to an **explicitly trusted copy of the pinned version**.
Remote workdirs cannot use Main's local binary or downloaded files.

Prefer what the user already has. Before downloading, inspect the relevant
Skill and discover existing model caches, local release archives and
application-specific directories. Use the official HF or ModelScope client
for repo browsing, authentication, snapshot metadata and revision resolution;
aria2 transfers **individual HTTPS files**, not repository snapshots
or login sessions. It does not bypass the GFW: when Hugging Face is blocked,
prefer a verified ModelScope repository and revision instead of an untrusted
mirror. Never copy into HF's internal blob/snapshot layout by hand.

For each file, identify its exact repository, revision, official origin,
expected SHA-256, optional byte count, license, free space and destination.
Obtain the user's consent to the network request, license and disk usage
before using `approved: true`. No download happens at startup. Use a
persistent user-chosen directory, not a session temp directory or the source
repository. The `download` action accepts `url`, `directory`, `filename`,
`sha256`, optional `bytes` and `approved: true`. Prefer `action: "start"`
for large downloads: it immediately returns `executionId` and `outputPath`.
Read the returned `outputPath` directly for progress/output, and use
`cancel({executionId})` to stop the transfer. Keep the full `bg:` prefix:
`executionId: "bg:0123456789abcdef"` has
`outputPath: "v:bg/bg:0123456789abcdef"`.
The raw `taskId` is compatibility metadata, not a VFS path or cancellation
reference. `v:bg` aggregates several execution kinds; its mount name does not
replace the `bg:` part of an execution ID. Do not poll; completion is delivered
automatically. Cancellation preserves resumable partial data.
`action: "download"` waits for completion and is intended only for
short files. Both actions stage under
`<filename>.shadow-part` with aria2 resume metadata, checks the final length
and SHA-256, then exposes the named file. The same destination and file name
can resume after interruption. A different file already at the final path
is never overwritten; a checksum mismatch discards bad partial data and
returns an error. An already verified file is reused.

HTTP range support and stable file identity determine whether a transfer
can resume. If a signed link expires, reacquire it from the same trusted
repository and revision; **do not combine unrelated revisions or URLs**
into one partial file. If resume fails or a server ignores range requests,
report the error and retry only after checking the source and disk state.
Failures include bounded TLS, DNS, timeout, HTTP or disk hints when recognized,
not raw downloader output. A TLS failure is not evidence that the source file
is missing; do not disable certificate checks or blindly repeat the transfer.
Do not log signed URLs, tokens, cookies or authorization headers; signed
links are passed to aria2 through stdin rather than command-line arguments. This
tool does not accept credentials. Avoid arbitrary download scripts, insecure
TLS flags, unaudited installer commands or unauthenticated aria2 RPC
servers. It spawns one bounded local CLI process without a shell and
supports cancellation while preserving resumable partial files.

Transfers respect standard HTTP(S) proxy environment variables or, on Windows
when those are absent, the user's existing static system proxy and bypass
rules. Shadow does not change system settings or disable TLS verification.
Proxy addresses also travel through stdin, not process arguments. PAC/SOCKS
configuration and credential-bearing proxy URLs fail explicitly; this tool
does not retrieve proxy credentials or substitute an unapproved network route.
