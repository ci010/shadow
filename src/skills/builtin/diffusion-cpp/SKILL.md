---
name: diffusion-cpp
description: "Use optional local stable-diffusion.cpp for Qwen Image 2.1 images/edits, legacy Qwen-Image-Edit, Anima, Z-Image-Turbo on constrained hardware, MiniMax-H3 audio/video, and MOSS-Image Base/SFT via explicit upstream CLI (no Shadow preset). Reuse existing weights first; inspect hardware, licenses, ModelScope downloads and CLI failures."
core: true
metadata:
  category: tools
---

# Local image and video with stable-diffusion.cpp

Shadow ships neither `sd-cli` nor weights. Start with `diffusion_cpp status` and
`diffusion_cpp discover` (find its contract with
`search(query="diffusion_cpp", handler="grep", path="v:tools")` and call via
`invoke_tool`). `status` distinguishes missing configuration from accessible
paths; **neither an accessible path nor a discovery candidate proves the model
can run**. `inspect` can show CLI `help` or `devices`. All operations are local
to the owning Project and execution node; never interpret a remote workdir
display path on Main. `image` defaults to Qwen Image 2.1. Z-Image-Turbo is an
explicit lower-resource text-to-image alternative, not an automatic fallback
or a replacement for Qwen editing. Legacy Qwen-Image-Edit and Anima are
separate opt-in image presets. `video` uses MiniMax-H3. Do not download,
run, or switch models silently.

## Device-local shared runtime and model storage

Reuse configured absolute paths and existing HF/ModelScope/ComfyUI caches first;
never move an existing installation or redownload merely to normalize its layout.
For new files, the default is the executing device's OS-user data directory,
without a Shadow parent:

- Windows: `%LOCALAPPDATA%/stable-diffusion.cpp` (resolve LOCALAPPDATA on that device).
- macOS: `~/Library/Application Support/stable-diffusion.cpp` (resolve that device's home).
- Linux: `${XDG_DATA_HOME:-~/.local/share}/stable-diffusion.cpp` (absolute XDG_DATA_HOME only).

Use `versions/<version-arch-backend>/` for binaries and adjacent libraries,
`models/` for new weights. Diffusion has no automatic installer: manually install
verified release archives under a pinned release-version/architecture/backend
identity, preserving adjacent libraries and existing cache files in place.
Files are shared across Projects/sessions only for the same OS user on the same
device; Project configuration, license acknowledgement and execution permissions
remain separate. A discovered file is not permission to run it. Configured binary
paths take priority, then the host CLI environment override, then PATH, then
bounded shared-directory discovery (direct/bin or one unambiguous versions entry).
Multiple versions require explicit configuration; discovery never probes them.
Do not guess usernames, resolve remote paths on Main, or fall back from a remote
executor to Main. These tools still require their implemented local execution route.

Runtime binaries and reusable model weights are dependencies, **not finished
Documents/workspace deliverables**. Do not put new dependencies under Documents,
a workspace, Project Home or session storage by applying deliverable rules.
Generated user-facing media/files still follow the requested output destination.
Downloads/installations always require source, disk and license approval; this
storage policy does not itself authorize downloading, installing or execution.

## First look for what the user already has

1. Run `status` and `discover` **before any network request**. Discovery checks
   `SHADOW_MODELS_DIR`, `HF_HUB_CACHE` (or `HF_HOME\hub`), `MODELSCOPE_CACHE`
   (normally `~\.cache\modelscope\hub`), common ComfyUI `models` paths,
   and the device-local `stable-diffusion.cpp/models/` default.
   Add user-approved absolute directories through `discover.roots`; inspect
   ComfyUI's configured `extra_model_paths.yaml` with the user's permission
   when it points elsewhere. HF snapshots often contain symlinks to blobs.
   Never sweep a whole disk or examine unrelated/private files to find models.
2. Most candidates report `filename_and_size_only`; the legacy Qwen Diffusers
   cache reports `index_and_shard_headers_only` only after checking its
   manifest, both weight indexes, every named shard and the VAE header.
   Neither check proves tensor integrity or successful inference. Discovery also reports unreadable
paths in `warnings` and incomplete scans with `truncated`. Verify actual format, variant,
   license and provenance. `configure` checks exact family-specific component
   names and GGUF/safetensors headers; it does **not** verify the tensors,
   provenance, SHA-256, GPU support, or inference. Compare downloaded files
   with the selected repository/revision's published SHA-256 when available,
   then do a small real generation on that device. An ordinary
   Qwen3-VL-32B weight is **not** the MiniMax-H3 encoder: H3's checkpoint
   is truncated to 50 language layers, omits final LM normalization, and
   requires its matching vision tower/DeepStack mergers. The Qwen Image
   2.1 VAE is not interchangeable with older Qwen/Wan VAEs; a generic
   `ae.safetensors` must be identified by origin before using it for Z.
3. If all compatible files exist, configure their absolute paths in place:
   no rename, copy, conversion, or second download. Config lives in the
   owning Project Home's `.diffusion-cpp.json`; another Project must opt in
   separately. Outputs are created under the current session's private
   `media` directory, never beside the weights. Ask the user to review the
   weight license **before** setting `licenseAcknowledged: true`, including
   when importing existing files or changing a configured model component.

There is no universal shared cache. HF Hub commonly uses
`~\.cache\huggingface\hub`, ModelScope commonly uses
`~\.cache\modelscope\hub`, and ComfyUI uses its own models tree or
`extra_model_paths.yaml`. Respect environment overrides. Do not put
ModelScope downloads inside HF's internal cache layout or treat a
temporary session directory as permanent storage. When a file is missing,
show precisely which components, sizes, disk space and license are involved;
ask before downloading. Prefer the user's existing cache or a persistent
shared directory they choose (including an external disk). If neither is
available, use the device-local `stable-diffusion.cpp/models/` default above.
Use a pinned revision, per-file download, checksum verification and a
complete file before calling `configure`; do not fetch entire Diffusers
repositories just to obtain a few components. GitHub release archives
with a published SHA-256 can be transferred via `v:skills/download`
and the bundled `download` tool; provider CLIs remain responsible for
authenticated repository access and revision selection. GitHub release archives
also require a pinned version and SHA-256 release-asset digest; Windows
CUDA releases need the **matching additional CUDA runtime** alongside
`sd-cli`. If GitHub is blocked, use a verified offline archive, not an
unverified installer/mirror. No automatic startup installs.

## Qwen Image 2.1 (default image and edit)

Use the [upstream guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md).
The recommended Q4 combination is:

| `configure` field | Filename | ModelScope repository |
| --- | --- | --- |
| `diffusion` | `qwen_image_2.1-Q4_K.gguf` | [`leejet/Qwen-Image-2.1-GGUF`](https://www.modelscope.cn/models/leejet/Qwen-Image-2.1-GGUF) |
| `vae` | `qwen_image_2.1_vae_bf16.safetensors` under `vae/` | [`Comfy-Org/Qwen-Image-2.1`](https://www.modelscope.cn/models/Comfy-Org/Qwen-Image-2.1) |
| `llm` | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | [`Qwen/Qwen3-VL-8B-Instruct-GGUF`](https://www.modelscope.cn/models/Qwen/Qwen3-VL-8B-Instruct-GGUF) |
| `vision` for editing | `mmproj-Qwen3VL-8B-Instruct-F16.gguf` | same Qwen3-VL repository |

Text-to-image downloads total approximately **9.90 GB**; editing adds
approximately **1.16 GB**. These figures exclude runtime buffers and
download staging. Edit by passing `reference` to `image`, only once the
matching `vision` file is configured; an ordinary text-to-image setup does
not enable editing. Qwen uses `--cfg-scale 6 --sampling-method euler --fa
--offload-to-cpu`; sizes must be multiples of 32. A lower-bit GGUF saves
weight space at a quality cost but does not remove encoder/activation and
prefix-cache pressure. The upstream guide documents cache use; **do not
promise a minimum VRAM from a weight file's size**. Start a smoke test with
512 x 512 and monitor actual RAM, VRAM and runtime.

The [original Qwen Image 2.1 license](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/LICENSE)
is the **Qwen Research License**, for non-commercial purposes only. Obtain
the user's confirmation before configuration or download. A quantized
mirror with blank license metadata does not grant commercial rights.

## Cached legacy Qwen-Image-Edit (optional editing only)

The older [`Qwen/Qwen-Image-Edit`](https://huggingface.co/Qwen/Qwen-Image-Edit)
is **not** Qwen Image 2.1. It uses a Qwen2.5-VL encoder and older Qwen
Image VAE. Its Diffusers cache can be used in place if it contains a
`QwenImageEditPipeline` manifest, the `qwen2_5_vl` text encoder config,
both complete shard indexes and a VAE. For example, the usual ModelScope
root is `~\.cache\modelscope\hub\models\Qwen\Qwen-Image-Edit`;
`discover` returns the absolute paths. Configure **all three from this
same cache**, without copying or converting any weights:

| `configure` field | Path beneath the cache root |
| --- | --- |
| `diffusion` | `transformer\diffusion_pytorch_model.safetensors.index.json` |
| `llm` | `text_encoder\model.safetensors.index.json` |
| `vae` | `vae\diffusion_pytorch_model.safetensors` |

Pass a `reference` image on every `image` request with
`preset: "qwen_image_edit"`; this is **not text-to-image**. The upstream
[edit guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_edit.md)
uses `--cfg-scale 2.5 --sampling-method euler --diffusion-fa
--flow-shift 3 --offload-to-cpu`, not the Qwen 2.1 flags. The indexed
Diffusers loader in upstream `sd-cli` resolves the 9 transformer shards
and 4 encoder shards by their indexes; do **not** pass one shard as a
complete model. The unquantized cache can exceed 50 GiB and still needs
substantial RAM/VRAM to run. Discovery and configuration validate files
and headers, not model identity, hashes or successful GPU loading; perform
a small smoke edit with the installed CLI before relying on it. The
[original weight license](https://huggingface.co/Qwen/Qwen-Image-Edit/blob/main/LICENSE)
is Apache-2.0; review its terms and explicitly acknowledge them even
when reusing a cached copy. If the installed CLI cannot load the indexed
Diffusers format, report that incompatibility; do not silently download
a duplicate quantized checkpoint.

## Anima (optional text-to-image)

Anima is a separate [CircleStone Labs model](https://huggingface.co/circlestone-labs/Anima),
not an SDXL checkpoint or Qwen Image 2.1. The upstream
[sd.cpp guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/anima.md)
uses `--diffusion-model`, `--llm`, `--vae`, Euler sampling and
`--diffusion-fa --offload-to-cpu`. Use the three *matching* files:

| `configure` field | Official `circlestone-labs/Anima` file |
| --- | --- |
| `diffusion` | `split_files/diffusion_models/anima-turbo-v1.1.safetensors` (or an explicitly selected preview/base/aesthetic variant) |
| `llm` | `split_files/text_encoders/qwen_3_06b_base.safetensors` |
| `vae` | `split_files/vae/qwen_image_vae.safetensors` |

The three official files total about **5.24 GiB** before staging,
buffers or memory for inference. Turbo defaults to CFG 1 and 10 steps;
base/aesthetic/preview default to CFG 4.5 and 35 steps. Override these
per request after checking the variant's own recommendations. This
preset is text-to-image only: do not attach an edit reference or confuse
it with similarly named anime SDXL models. An HF `refs` entry without
snapshot files or weight blobs **is not a downloaded model**. Even if
you find a Qwen Image VAE elsewhere, verify its repository and
checksum before reusing it; a Diffusers `diffusion_pytorch_model`
is not automatically interchangeable with the split-file
`qwen_image_vae.safetensors`.

The [official license](https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md)
is CircleStone Labs Non-Commercial v1.2, with additional NVIDIA
derivative-model terms; obtain the user's explicit authorization before
configuration or any download, even if they already have files. When
Hugging Face is unavailable, the
[ModelScope mirror](https://www.modelscope.cn/models/circlestone-labs/Anima)
has the same relative filenames; verify the chosen revision, license,
hashes and completeness before using it. Download only missing files
with `modelscope download --model circlestone-labs/Anima
<relative-file> --revision <pin> --local_dir <chosen-cache>`, once the
user approves destination, license and disk usage. No automatic
download or replacement of Qwen 2.1's default image preset.

## MOSS-Image Base / SFT (explicit upstream CLI only)

The [upstream MOSS guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/moss_image.md)
supports both **Base and SFT**: a 5B diffusion transformer, Qwen3.5-9B text
encoder and FLUX.2 VAE. Prompt enhancement is not included. This guidance was
checked against [sd.cpp revision 73fef082](https://github.com/leejet/stable-diffusion.cpp/blob/73fef08224c50a49961004dc8c6fee2c0f640bcb/docs/moss_image.md).
MOSS support landed in [68285df3](https://github.com/leejet/stable-diffusion.cpp/commit/68285df319457e2d79310b48513e4ba1bf8ebe9a);
use a verified build containing that change, not an arbitrary older `sd-cli`.
The checked release [master-1073-991f825](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-1073-991f825)
contains it; this is a known-containing release, not a claim of the minimum
release. Inspect the installed version/help and backend first; do not replace
an existing installation automatically.

**Shadow has no MOSS preset**: `diffusion_cpp configure` and `image` do not
accept MOSS, and there is no tokenizer configuration field. Discovery does not
validate a complete MOSS setup. Do not impersonate another preset or pass model
selectors through `options`. Use an explicitly approved local `sd-cli` command
on the executing device, outside the integrated generation tool; no automatic
Project configuration, generation locking/cancellation or media delivery is
provided by that direct route.

### Short end-to-end setup and first run

Treat a request to set up MOSS as the following workflow, not just a command
example. Carry out authorized steps; ask only for missing download/license or
execution decisions, and stop with a precise blocker when necessary.

1. **Check the execution device.** Run `status`/`discover` first, inspect the
   installed CLI version/help and GPU backend, and check free disk/RAM/VRAM.
   Reuse a compatible runtime; if missing or too old, obtain approval for a
   pinned, checksum-verified release and install its complete package (including
   matching CUDA libraries) in the shared `versions/` directory. Never execute
   a remote binary on Main or infer MOSS support from GPU detection alone.
2. **Resolve all four components.** Select Base or SFT, inventory existing
   files, and resolve the exact diffusion, Qwen3.5 encoder, FLUX.2 VAE and
   **external tokenizer JSON** from the table below. Report only missing files,
   pinned source revisions, sizes/total disk needs and applicable licenses;
   obtain required approval before downloading. Do not fetch both variants or
   a whole repository merely to get its tokenizer.
3. **Download and verify.** Follow `v:skills/download` for eligible public
   HTTPS files, or the provider's revision-pinned per-file downloader. Reuse
   caches; save new components under shared `models/moss-image/` (or the chosen
   persistent location), preserving existing paths. Verify trusted published
   hashes where available; if unavailable, disclose the integrity limitation
   rather than inventing a digest. Parse the tokenizer as JSON, require its
   vocabulary/model structure, and confirm its upstream origin/revision; a
   filename or successful JSON parse alone does not establish compatibility.
4. **Wire the paths.** Record the resolved absolute CLI and four component
   paths plus source revisions in a small setup manifest in the chosen model
   directory, without overwriting an existing file. Pass those actual paths to
   the example below, especially `--tokenizer`; do not call MOSS `configure`
   or substitute another preset. Files may stay in separate existing caches:
   the example's common `MOSS_ROOT` is only a layout illustration, not a copy
   requirement. The manifest is a reuse aid, not a Shadow configuration file.
5. **Run one smoke generation.** Use the approved prompt and a new durable
   output path, one job at a time on the device. Start with a modest size
   divisible by 16 (for example 512 x 512; the upstream example is 1024 x 1024),
   using the MOSS flags below. Retain the process result/log and elapsed time;
   use the execution tool's supported timeout/cancellation handling. On OOM,
   report evidence and propose a smaller size/offload adjustment; do not loop
   downloads or silently switch model variants.
6. **Verify and hand back.** Require a successful process exit, then open the
   resulting PNG to check it decodes, has the requested dimensions and contains
   a plausible result. Report its actual output path, runtime/backend, variant,
   reusable component/manifest paths and measured elapsed time (resource peaks
   only if measured). CLI help, configured paths or a file existing alone are
   not end-to-end success. If generation is deferred or fails, say setup is
   partial and give the exact next action; do not claim successful inference.

Select one diffusion variant, plus all three matching sidecars:

| Component | Upstream file / source |
| --- | --- |
| Base diffusion | `diffusion_models/moss_image_base_int8_convrot_attn.safetensors` from [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image/tree/main/diffusion_models), or [leejet/MOSS-Image-Base-GGUF](https://huggingface.co/leejet/MOSS-Image-Base-GGUF) |
| SFT diffusion (alternative, not an extra requirement) | `diffusion_models/moss_image_sft_int8_convrot_attn.safetensors` from the same Comfy-Org repository, or [leejet/MOSS-Image-SFT-GGUF](https://huggingface.co/leejet/MOSS-Image-SFT-GGUF) |
| Text encoder | `Qwen3.5-9B-Q4_K_M.gguf` from [unsloth/Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) |
| VAE | `vae/flux2_ae.safetensors` from [Comfy-Org/MOSS-Image](https://huggingface.co/Comfy-Org/MOSS-Image/tree/main/vae) |
| External tokenizer | `tokenizer/tokenizer.json` from [OpenMOSS-Team/MOSS-Image-Base](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/tree/main/tokenizer) |

`--tokenizer` is required: Qwen3.5 has a different vocabulary from the embedded
Qwen tokenizer. Do not substitute Qwen3/Qwen3-VL encoders, Qwen Image VAEs or
an unrelated tokenizer. Resolve exact filenames, revisions, sizes and hashes
before any download (especially when selecting a GGUF quantization); the two
diffusion formats above are alternatives, not a reason to fetch both.

After license and execution approval, this POSIX-shell Base example follows
the upstream flags. Replace every placeholder with discovered absolute paths;
`SDCLI`, `MOSS_ROOT` and `OUTPUT` are illustrative shell variables, not Shadow
configuration. `OUTPUT` must be a new user-approved PNG destination, not a path
beside model weights. On Windows use equivalent PowerShell invocation syntax.

```sh
SDCLI='/absolute/path/to/sd-cli'
MOSS_ROOT='/absolute/path/to/existing-or-approved-moss-components'
OUTPUT='/absolute/path/to/new-moss-base.png'
"$SDCLI" --diffusion-model "$MOSS_ROOT/diffusion_models/moss_image_base_int8_convrot_attn.safetensors" \
  --llm "$MOSS_ROOT/text_encoders/Qwen3.5-9B-Q4_K_M.gguf" \
  --vae "$MOSS_ROOT/vae/flux2_ae.safetensors" \
  --tokenizer "$MOSS_ROOT/tokenizer/tokenizer.json" \
  --cfg-scale 3.0 -p 'a lovely cat holding a sign says moss-image.cpp' \
  -v --offload-to-cpu -H 1024 -W 1024 -o "$OUTPUT"
```

For SFT, replace only the diffusion path with the selected
`moss_image_sft_int8_convrot_attn.safetensors` and choose a distinct output.
Dimensions must be divisible by 16. The default discrete scheduler uses time
shift 5; `--flow-shift` overrides it. The negative CFG branch skips DiT layer
22 (zero-based). Do not transplant Qwen/Z/Anima sampling defaults or claim
reference editing support. Check installed help before adding optional flags.
Use a small approved smoke generation first and inspect the resulting PNG;
file size, quantization and CPU offload do not guarantee VRAM fit, RAM use,
quality or performance. No universal minimum VRAM or runtime is established here.

Reuse existing paths first. For approved new dependencies, use the device-local
shared `stable-diffusion.cpp/models/` directory described above (for example a
`moss-image/` subtree), or the user's chosen persistent cache; keep binaries in
pinned `versions/` entries and generated outputs separate. Never move existing
weights, silently download models, or install a new runtime just to try MOSS.

Review the original [Base model card/license](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base)
and [SFT model card/license](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT),
the selected repack/quantization revision, and the Qwen3.5 encoder, FLUX.2 VAE
and tokenizer terms independently. The [OpenMOSS code README](https://github.com/OpenMOSS/MOSS-Image#license)
labels the **standalone pipeline code** Apache-2.0; this is not proof of the
weights' license. Weight licenses were not independently verified for this
guide: if a model card/license cannot be retrieved, report that limitation and
obtain confirmation of the applicable terms/authorization before download or
execution, including cached weights. sd.cpp's MIT license and a mirror's label
are not substitutes for upstream weight rights.

## Lower-resource text-to-image: Z-Image-Turbo

When the GPU/available RAM cannot reasonably support Qwen 2.1, run
`diffusion_cpp inspect` with `which: "devices"`, check available RAM, VRAM
and disk, explain quantization/CPU-offload tradeoffs and **recommend** the
Z-Image-Turbo setup. Do not switch the preset without user approval.
On Windows, `Get-CimInstance Win32_ComputerSystem` reports physical RAM
and `Get-PSDrive -PSProvider FileSystem` reports disk free space; for
NVIDIA GPUs `nvidia-smi --query-gpu=memory.total,memory.free
--format=csv,noheader` reports VRAM. For other GPUs, consult the
installed backend and vendor tool rather than interpreting system RAM as
dedicated VRAM. Prefer *available* memory to nominal totals and include
space for staging; never download solely on the basis of a model size.
The upstream [Z-Image guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/z_image.md)
demonstrates:

| `configure` field | Filename | ModelScope repository |
| --- | --- | --- |
| `diffusion` | `z_image_turbo-Q3_K.gguf` | [`hf/leejet-Z-Image-Turbo-GGUF`](https://www.modelscope.cn/models/hf/leejet-Z-Image-Turbo-GGUF) |
| `llm` | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | [`unsloth/Qwen3-4B-Instruct-2507-GGUF`](https://www.modelscope.cn/models/unsloth/Qwen3-4B-Instruct-2507-GGUF) |
| `vae` | `ae.safetensors` under `split_files/vae/` | [`Comfy-Org/z_image_turbo`](https://www.modelscope.cn/models/Comfy-Org/z_image_turbo) |

The three files total approximately **5.98 GB**. Use model-specific
`--cfg-scale 1 --steps 8 --diffusion-fa --offload-to-cpu`, not Qwen's
parameters. The upstream guide says 4 GB VRAM *can* work with offloading;
that is not a universal speed or RAM guarantee. If neither model fits,
say so rather than downloading several gigabytes anyway. This preset
supports text-to-image in Shadow; do not claim Qwen-equivalent editing.
Review each component's original license before use.

## MiniMax-H3 (default video with stereo audio)

Follow the [upstream MiniMax-H3 guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md):

| `configure` field | Filename | ModelScope repository |
| --- | --- | --- |
| `diffusion` | `minimax_h3_fl2va-Q4_K_M.gguf` | [`leejet/MiniMax-H3-GGUF`](https://www.modelscope.cn/models/leejet/MiniMax-H3-GGUF) |
| `llm` | `qwen3vl_32b_minimax_h3-Q4_K_M.gguf` | same GGUF repository; **not** general Qwen3-VL-32B |
| `vae` | `minimax_h3_video_vae_fp16.safetensors` | [`Comfy-Org/MiniMax-H3`](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3) |
| `audioVae` | `minimax_h3_audio_vae_fp32.safetensors` | same Comfy-Org repository |
| `refDiffusion` (optional) | `minimax_h3_ref2va-Q4_K_M.gguf` | same GGUF repository |

This full Q4 text/first-last-frame plus AV set is approximately **42.81 GB**,
before inference memory, staging or an optional separate Ref2VA model. Some
pruned/repacked variants have different sizes and capabilities; verify their
compatibility independently. If the specialized H3 encoder's vision tower
is stored separately, configure its matching `vision` projection as well;
the suggested combined GGUF does not require another file. `video` defaults to FL2VA; `initImage` sets the
first frame, `endImage` requires the first, and `mode: "ref2va"` requires
`refDiffusion` and accepts `referenceImages`. Video/audio references are
described in the upstream CLI documentation but are **not exposed by this
Shadow tool**. H3 requires 24 fps and frame counts of 17k+5 (e.g., 56).
The tool outputs **WebM**, which `sd-cli` can mux with its audio; MP4 is
not the CLI output in this integration. Agent replies can attach the tool's
returned session-relative path with `MEDIA:media/<generated-file>.webm`.
The same convention applies to the generated PNG.

The [official MiniMax-H3 Community License](https://www.modelscope.cn/models/MiniMax/MiniMax-H3/file/view/master/LICENSE)
excludes the US, EU, UK and Republic of Korea from its standard territory;
use in those places requires separate authorization. It also requires
prior written authorization above its specified commercial revenue
threshold, attribution in commercial interfaces, and conditions on
redistribution and hosted services. Review the current license and
ask the user to confirm their authorization **even if they already have
the weights**. Do not offer unlicensed downloads or equate sd.cpp's
MIT license with rights to H3 weights.

## Invoking and troubleshooting

`configure` accepts one preset's absolute `diffusion`, `vae`, `llm` and
applicable sidecars, plus `licenseAcknowledged: true` after user review.
It checks file presence, filename family and header, but a real
device/model generation is still required to verify compatibility. An
installed CLI on `PATH` or set by `SDCPP_CLI_PATH` does not need a binary
configuration; to configure one explicitly, use its absolute `sd-cli` path.
For example, after the user's license confirmation and discovery of actual
files, a Qwen configuration is shaped as:

```json
{"action":"configure","preset":"qwen_image_2_1","diffusion":"D:\\AI\\models\\qwen_image_2.1-Q4_K.gguf","vae":"D:\\AI\\models\\qwen_image_2.1_vae_bf16.safetensors","llm":"D:\\AI\\models\\Qwen3VL-8B-Instruct-Q4_K_M.gguf","licenseAcknowledged":true}
{"action":"image","prompt":"a cat by the sea","width":512,"height":512}
{"action":"video","prompt":"a cat walking by the sea with matching ocean sound","frames":56}
```

The paths above are examples, **not** assumed installation locations;
`video` requires the separately configured H3 preset. The `media` value
returned by a generation is relative to the owning session data directory.
`inspect` with `which: "help"` shows the installed version's live flags
before adjusting advanced `options`. Options are a shell-free argv array;
Shadow owns model/input/output/frame selectors. Request a short,
low-resolution smoke generation before an expensive video request. Calls
can be cancelled and one generation per Project runs at a time.
To remove an optional Qwen editing projection or H3 Ref2VA model, pass
an empty string as `vision` or `refDiffusion` in `configure` after license
review; required base components cannot be cleared.

For mainland China, use the verified ModelScope repositories above. Its
[CLI](https://github.com/modelscope/modelscope/blob/master/docs/source/command.md)
downloads **individual repository-relative files** with
`modelscope download --model <repo> <relative-file> --revision <pin>
--local_dir <user-chosen-directory>`. For example, after choosing a
persistent destination and checking **each repository's own** revision:

```powershell
$root = 'D:\AI\models'
modelscope download --model leejet/Qwen-Image-2.1-GGUF qwen_image_2.1-Q4_K.gguf --revision '<qwen-pin>' --local_dir "$root\qwen-diffusion"
modelscope download --model Comfy-Org/Qwen-Image-2.1 vae/qwen_image_2.1_vae_bf16.safetensors --revision '<qwen-vae-pin>' --local_dir "$root\qwen-vae"
modelscope download --model Qwen/Qwen3-VL-8B-Instruct-GGUF Qwen3VL-8B-Instruct-Q4_K_M.gguf --revision '<qwen-vl-pin>' --local_dir "$root\qwen-encoder"
modelscope download --model Qwen/Qwen3-VL-8B-Instruct-GGUF mmproj-Qwen3VL-8B-Instruct-F16.gguf --revision '<qwen-vl-pin>' --local_dir "$root\qwen-encoder"
modelscope download --model hf/leejet-Z-Image-Turbo-GGUF z_image_turbo-Q3_K.gguf --revision '<z-pin>' --local_dir "$root\z-diffusion"
modelscope download --model unsloth/Qwen3-4B-Instruct-2507-GGUF Qwen3-4B-Instruct-2507-Q4_K_M.gguf --revision '<z-encoder-pin>' --local_dir "$root\z-encoder"
modelscope download --model Comfy-Org/z_image_turbo split_files/vae/ae.safetensors --revision '<z-vae-pin>' --local_dir "$root\z-vae"
modelscope download --model circlestone-labs/Anima split_files/diffusion_models/anima-turbo-v1.1.safetensors --revision '<anima-pin>' --local_dir "$root\anima"
modelscope download --model circlestone-labs/Anima split_files/text_encoders/qwen_3_06b_base.safetensors --revision '<anima-pin>' --local_dir "$root\anima"
modelscope download --model circlestone-labs/Anima split_files/vae/qwen_image_vae.safetensors --revision '<anima-pin>' --local_dir "$root\anima"
modelscope download --model leejet/MiniMax-H3-GGUF minimax_h3_fl2va-Q4_K_M.gguf --revision '<h3-pin>' --local_dir "$root\h3-diffusion"
modelscope download --model leejet/MiniMax-H3-GGUF qwen3vl_32b_minimax_h3-Q4_K_M.gguf --revision '<h3-pin>' --local_dir "$root\h3-encoder"
modelscope download --model Comfy-Org/MiniMax-H3 vae/minimax_h3_video_vae_fp16.safetensors --revision '<h3-vae-pin>' --local_dir "$root\h3-vae"
modelscope download --model Comfy-Org/MiniMax-H3 vae/minimax_h3_audio_vae_fp32.safetensors --revision '<h3-vae-pin>' --local_dir "$root\h3-vae"
```

The `<...-pin>` placeholders are **not literal revisions**: resolve a
specific revision from the selected repository before running commands
and preserve its file hash. Only download missing components for the
chosen preset; the vision file is for Qwen edits, and the H3 Ref2VA
diffusion weight is a separate optional download. Check the chosen
mirror actually has that revision/file and published SHA-256; a mirror
may lag. Never
silently substitute a different quantization, switch to Hugging Face,
or treat a partial file as complete. HF and ModelScope do not share
cache metadata; existing HF snapshots can still be used directly.

If `status` reports a missing path, re-run bounded discovery. If the
header is invalid, check for a truncated download or a Git LFS pointer.
For CLI errors inspect `help`/`devices`, matching backend build and
adjacent runtime libraries. Qwen edit requires its mmproj. H3 needs
the MiniMax-specific encoder and audio VAE for sound, with enough
RAM/VRAM for *all* components. A failing `sd-cli` invocation,
missing output or invalid PNG/WebM is an error, not a successful
generation. Web preview of a completed attachment is supported;
progressive image/video streaming is not part of this CLI integration.
