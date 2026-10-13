---
name: audio-cpp
description: "Set up, inspect and use optional local audio.cpp ASR/TTS; download verified binaries and GGUF models including a ModelScope route for China; diagnose model, backend and CLI option problems."
core: true
metadata:
  category: tools
---

# Optional local audio.cpp

Shadow does **not** ship audio.cpp executables or model weights. Do not claim
speech recognition or synthesis is available until `audio_cpp status` shows an
installed CLI and the requested model. Discover the `audio_cpp` contract with
`search(query="audio_cpp", space="grep:v:tools")`, then call it with
`invoke_tool`. Its `status`, `assess`, `setup`, `configure_remote`, `inspect`, `configure`, `transcribe`, and `speak`
actions are the supported Shadow integration. The local backend runs on the owning host only: a
remote workdir must use a capability implemented on its own node, not Main's
binary or model directory. An explicitly selected remote API route runs from the
owning host and sends content only when transcribe/speak is invoked. Request user consent before network downloads,
large disk use or a model with special license terms.

## Unified Agent-driven setup

The composer **Set up audio** button asks local vs remote and submits the choice to
the session Agent. It does not record or upload. Import `audio` (same service as
`audio_cpp`), then use `assess`, approval-gated `setup`, or `configure_remote`.
Assess a specific model/backend with measured host RAM/disk/OS/architecture and
published model-specific memory evidence, not universal guessed thresholds.
Unsuitable recommends remote; unknown is not proof of incompatibility. Never switch
or upload without the user choosing remote. `setup` verifies a self-contained ZIP CLI
and single-file GGUF using trusted pinned SHA-256/size metadata, probes the CLI before
model download, then registers managed paths and local task route automatically.
No manual config/path edits, shell installers or implicit startup downloads.

`setup` takes setup={approved:true,binary:{url,sha256,bytes,entry,platform,arch},
model:{url,sha256,bytes,family},task,backend?,options?}. `assess` takes candidate=
{family,backend?,downloadBytes,platform,arch,minimumMemoryBytes?,memoryEvidence?}.
The optional memory requirement needs its published evidence URL.
`configure_remote` takes task and remote={baseUrl,model,apiKeyEnv?}; API key values
must never enter chat/tool arguments. Use an existing host environment reference.
This config action uploads nothing. Credential provisioning remains host-side.
transcribe/speak use the selected task route, without silent fallback. Local
configure/setup selects local; remote configuration selects remote. Configure
and CLI help/catalog probes are not successful inference; test a consented sample.

SenseVoice-Small Q8 uses family `sense_asr`, package `sensevoice_small_q8`, file
`sensevoice-small-q8-audiocpp-v1.gguf`, repo `FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp`.
Model spec revision `5c3fcfe748a8714216bc135476d5863084fddb72` is evidence, not a
weight SHA-256. Resolve trusted pinned digest/size/license before setup and verify
the chosen CLI supports sense_asr. One-ZIP setup requires all adjacent runtime
libraries included; separate CUDA archives and multi-file model packages still
need the verified explicit import workflow below. See docs/audio-setup.md in the
source repository for limits and fixture-vs-live verification boundaries.

## Install the CLI, without guessing the asset

1. `audio_cpp status` reports the current configuration and the exact reason
   a configured binary or model cannot be used. `audio_cpp inspect` runs the
   installed CLI's `--list-loaders --json`; with `task` it reads model-specific
   CLI help. If no CLI is installed, use the upstream
   [release assets](https://github.com/0xShug0/audio.cpp/releases). Choose a
   pinned tag and the matching OS/architecture/backend. CPU is the portable
   starting point; macOS has Metal packages. The Windows CUDA packages require
   the **separate matching `cudart` archive**, extracted beside the binaries.
   Do not substitute a Linux/macOS package or assume `audiocpp_model_manager`
   is present in every release archive.
2. Download to an agent-controlled cache outside the repository or import an
   existing local archive when GitHub downloads are unavailable. Obtain the
   selected asset's `digest` using GitHub's release API and verify SHA-256
   before extraction. Reject missing or mismatched digests, zip-slip paths,
   links escaping the target, and any archive that lacks the expected
   `audiocpp_cli` (`.exe` on Windows). Preserve adjacent libraries/resources
   from the archive. Do not execute a downloaded binary before verification.
   Do not run an OS shell installer for a third-party mirror without explicit
   review; offline import is preferable when GitHub is blocked.
   For a public HTTPS asset with a published SHA-256, use
   `v:skills/download` and the bundled `download` tool for resumable
   transfer; do not invent a digest if the release has none.
3. Call `audio_cpp configure` with `binary` set to its absolute path. Shadow
   probes `--list-loaders --json` before saving. Both the legacy family array and
   the schema-version-1 `loaders` object are supported. Validate the CLI first,
   before downloading a large model. A rejected catalog leaves configuration
   unchanged; a probe/process failure still needs investigation. If the binary is already on
   `PATH`, the tool can discover it without configuration. Use `AUDIOCPP_CLI_PATH`
   as an optional host-level override; a configured binary takes priority.
   Nothing is added to an Electron installer or downloaded on Shadow startup.

## Install a model

The upstream release includes `tools/model_manager_v2.py` and `model_specs/`;
the Python manager requires Python 3 for downloading, **not inference**. Inspect
the selected model spec and license before install. Keep models in persistent
project-local storage rather than an ephemeral conversation directory. Prefer a
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

Configure each task explicitly, using **the GGUF file**, not the parent directory
when it contains several variants:

```json
{"action":"configure","task":"asr","family":"qwen3_asr","path":"C:\\chosen\\models\\Qwen3-ASR-0.6B-GGUF\\qwen3-asr-0.6b-q8_0.gguf","backend":"cpu"}
{"action":"configure","task":"tts","family":"kokoro_tts","path":"C:\\chosen\\models\\Kokoro-82M-GGUF\\kokoro-82m-q8_0.gguf","backend":"cpu","options":["--language","zh","--voice-id","zf_xiaobei"]}
```

Use `audio_cpp status` after configuration. `path_accessible` means the model
path can be read; it does **not** prove the weights, sidecars or backend are
compatible. For a model change, consult its
`model_specs/<family>.json`, run `audio_cpp inspect`, install the model and call
`configure` for that task again. `options` is an argv token array passed
without a shell; do not override Shadow-owned input/output paths or model/task
selectors. Explicitly choose a backend built into the installed binary; CPU
is a compatibility default, not a performance guarantee.

## Inference and troubleshooting

For Japanese Kokoro, check the selected release's voice/language support, MeCab
runtime and dictionary resources before inference; an English eSpeak setup does
not establish Japanese readiness. Verify a short Japanese WAV first, then user
playback, and only then an explicitly authorized virtual-microphone route.
Successful tokenization, accessible model paths and a working VRChat input are
different checkpoints. Do not install drivers, change default devices or route
audio into another application without authorization.

Use documented requirements and measurements for memory estimates. A chosen
safety margin is an assumption, not a proven minimum or user restriction.
Within approved resource/risk limits, prefer a short, cancellable low-concurrency
test over blocking indefinitely on an invented threshold. If no safe test is
possible, explain the measured risk and alternatives.

`audio_cpp transcribe` accepts a **WAV** path and returns `{"text":...}`.
Convert MP3/OGG/Opus/other uploads to WAV with an installed decoder such as
ffmpeg before calling it; do not relabel compressed bytes as WAV. Use an audio
sample rate supported by the chosen model (16 kHz mono for common ASR examples).
`audio_cpp speak` takes `text` and a **new** `.wav` output path; the returned
path can be sent using ordinary Shadow media/file tools. Neither action sends
audio to a third-party service. For microphone collection, use `v:skills/io`
and obtain capture consent first; its example produces a WAV but does not ASR.
CLI probes time out after 30 seconds and inference after 30 minutes; split
long recordings into WAV chunks if a job exceeds that window. Live web
streaming is not part of this CLI integration.

If invocation fails, inspect `status` (missing path vs wrong backend), then
`inspect` (registered family/CLI options). Run `--list-devices` with the
installed CLI when GPU selection is in doubt; verify adjacent runtime DLLs and
required model-side data (for example, Kokoro eSpeak resources for English).
Check the model-specific [upstream usage](https://github.com/0xShug0/audio.cpp/blob/main/docs/usage.md),
[model-manager guide](https://github.com/0xShug0/audio.cpp/blob/main/docs/model_manager.md),
and [model licenses](https://github.com/0xShug0/audio.cpp/blob/main/docs/model_licenses.md).
Report a missing binary, failed download, invalid model, unsupported format,
nonzero CLI exit or missing output as a failure, not an empty transcript.
