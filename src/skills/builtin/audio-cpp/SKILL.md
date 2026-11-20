---
name: audio-cpp
description: "Set up, inspect and use optional local audio.cpp ASR/TTS; download verified binaries and GGUF models including a ModelScope route for China; diagnose model, backend and CLI option problems."
core: true
metadata:
  category: tools
---

# Optional local audio.cpp

Shadow ships neither `audiocpp_cli` nor weights. Agent local inference uses
only ordinary `read`, `write`, and `exec`. The legacy Audio UI/API has separate
configuration and is not changed by this workflow. Do not silently switch to
network inference or upload audio.

## Project inventory and device scope

Use `read` and `write` on `v:cpp-installations/audio-cpp` and ordinary
OS-shell `exec` on the **same selected device** for discovery, hashing, probes
and inference. Select the execution workspace first; if it is unavailable,
stop. Do not mix per-call workspace overrides with inventory reads/writes; a
Child path is never a Main path. LayerFS is not an installation device.

Read the virtual file first. Copy `schemaVersion`, `projectId`, `node` and
`runtime` from the receipt, omit `installed`, and write a complete JSON record:
`binary` has `path`, `version`, `source`, `expectedSha256`, `observedSha256`;
`weights` is an array of objects with `role`, `path`, `source`,
`expectedSha256`, `observedSha256`. Use absolute **file** paths. Record every
required sidecar separately, with roles identifying the task/model component.
Use revision-pinned sources where known (never credentials), or `null` for
unknown provenance. Use `null` for an unavailable trusted expected digest,
never copy the measured hash into that field. Hash the files on the executing
device with `shasum -a 256` (macOS), `sha256sum` (Linux) or `Get-FileHash
-Algorithm SHA256` (PowerShell); record lowercase hex. Stop on a mismatch;
do not run untrusted files. Missing inventory is not evidence that the files
are absent. A cached digest is a historical observation, not a fresh check;
recheck before reuse and treat unverified provenance as a limitation requiring
review. Inventory writes do not install files, change Audio UI settings,
validate bytes on a remote device or authorize execution. Full writes replace
only the selected device/runtime record; preserve entries you still need.

## Device-local shared runtime and model storage

Reuse configured absolute paths and existing HF/ModelScope/ComfyUI caches first;
never move an existing installation or redownload merely to normalize its layout.
For new files, the default is the executing device's OS-user data directory,
without a Shadow parent:

- Windows: `%LOCALAPPDATA%/audio.cpp` (resolve LOCALAPPDATA on that device).
- macOS: `~/Library/Application Support/audio.cpp` (resolve that device's home).
- Linux: `${XDG_DATA_HOME:-~/.local/share}/audio.cpp` (absolute XDG_DATA_HOME only).

Use `versions/<version-arch-backend>/` for binaries and adjacent libraries,
`models/` for new weights. Audio's managed setup uses the pinned binary SHA-256
as version identity and keeps verified legacy Project download caches in place.
Files are shared across Projects/sessions only for the same OS user on the same
device; Project configuration, license acknowledgement and execution permissions
remain separate. A discovered file is not permission to run it. Configured binary
paths take priority, then the host CLI environment override, then PATH, then
bounded shared-directory discovery (direct/bin or one unambiguous versions entry).
Multiple versions require explicit configuration; discovery never probes them.
Do not guess usernames, resolve remote paths on Main, or fall back from a remote
executor to Main. Require a working OS shell on the selected device.

Runtime binaries and reusable model weights are dependencies, **not finished
Documents/workspace deliverables**. Do not put new dependencies under Documents,
a workspace, Project Home or session storage by applying deliverable rules.
Generated user-facing media/files still follow the requested output destination.
Downloads/installations always require source, disk and license approval; this
storage policy does not itself authorize downloading, installing or execution.

## Locate and inspect the CLI

Use the inventory, known existing absolute paths, `AUDIOCPP_CLI_PATH`, and
PATH (`command -v audiocpp_cli` or `Get-Command audiocpp_cli`). If necessary,
inspect the known shared runtime directories on that device. Never reinstall a
compatible runtime. After checking provenance and SHA-256, inspect `--help`
and the pinned build/release identity; verify the task/family flags against
`model_specs/<family>.json` for that revision. If missing, propose a trusted
pinned release with checksum, exact platform/architecture, adjacent libraries,
license and disk needs, and wait for approval before any download/install.

## Install a model

The upstream release includes `tools/model_manager_v2.py` and `model_specs/`;
the Python manager requires Python 3 for downloading, **not inference**. Inspect
the selected model spec and license before install. Keep existing models in place; for new weights use the shared device-local
`audio.cpp/models/` directory described above, not ephemeral conversation storage. Prefer a
ready-to-use single-file GGUF. The upstream manager stages downloads and
publishes a package manifest:

```powershell
python .\tools\model_manager_v2.py install qwen3_asr_0_6b_q8_0 --models-root "C:\chosen\models"
python .\tools\model_manager_v2.py install kokoro_82m_q8_0 --models-root "C:\chosen\models"
```

For access from mainland China, the upstream Python manager supports switching
the package source (changing `HF_ENDPOINT` alone is **not** a ModelScope
translation). The published
[ModelScope mirror](https://www.modelscope.cn/models/HereIsMark/audio.cpp-gguf)
has the Qwen3-ASR 0.6B Q8 and Kokoro 82M Q8 files at the time of writing:

```powershell
python .\tools\model_manager_v2.py install qwen3_asr_0_6b_q8_0 --source modelscope --source-repo HereIsMark/audio.cpp-gguf --models-root "C:\chosen\models"
python .\tools\model_manager_v2.py install kokoro_82m_q8_0 --source modelscope --source-repo HereIsMark/audio.cpp-gguf --models-root "C:\chosen\models"
```

Verify the model file exists, compare its SHA-256 with trusted package metadata
when available, and check the model's license separately from audio.cpp's
Apache-2.0 license. A mirror may lag upstream; never silently fall back to HF,
change a package ID, or label a partial download complete. Files transferred
offline can instead be passed by absolute path after integrity checks. The
Fun-ASR-Nano documentation and license summary disagree on its weight license;
verify the original model license before redistributing that package.

## Run and verify inference

Check selected family, backend and task-specific flags in installed CLI help.
These are argv examples; set the variables from actual verified files and new,
approved output paths. The PowerShell equivalent invokes the executable with
`& $cli` and passes each value as its own argument. Keep filenames and text
quoted as individual arguments; never interpolate untrusted text into code.

```sh
"$CLI" --task asr --family "$ASR_FAMILY" --model "$ASR_WEIGHT" --backend "$BACKEND" --audio "$INPUT_WAV" --text-out "$TRANSCRIPT"
"$CLI" --task tts --family "$TTS_FAMILY" --model "$TTS_WEIGHT" --backend "$BACKEND" --text "$TEXT" --out "$OUTPUT_WAV"
```

Require exit success and inspect transcript text via `read`, or validate that
TTS produced a nonempty decodable WAV. Do not overwrite an existing output.
Choose a short WAV and approved text for smoke tests only when requested;
report actual backend, runtime identity and output (or precise error).
