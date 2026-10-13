# Conventional audio setup

The composer **Audio input** (microphone icon) reads current Project audio status
on mount and Project/draft changes, not conversation history or browser storage.
With local ASR configured, clicking the microphone starts immediately; clicking
again stops and transcribes. Long-press for 300 ms, then release (including outside
the button) to stop and transcribe. The microphone sits immediately left of Send. Hover never captures audio; moving
onto its popup keeps it open. Escape or focus leaving dismisses it. Touch devices
have an explicit settings control. The popup is suppressed during gesture arming,
capture and processing; timers are cleared on navigation/deactivation/unmount.
Hold **Ctrl+Shift alone** for 300 ms to start; releasing either modifier stops only
keyboard-owned recording. Another key during arming cancels the gesture so normal
Ctrl+Shift shortcuts remain available. Repeats and IME composition do not arm it.
This is a focused-window browser shortcut, not an OS-global microphone hook.
The default shortcut is currently fixed; there is no shared customizable shortcut
registry/settings infrastructure to integrate in this iteration.

Recording requires browser/OS microphone permission and the existing trusted
desktop capture grant in Electron. Composer gestures reserve a microphone-only,
65-second grant and resume WebAudio in the original event, before the 300 ms hold
threshold; reservation never opens tracks. Electron preload observes the real
trusted microphone-button event or focused Ctrl+Shift chord (modifier keys and
touch pointerdown do not provide Chromium transient activation). The observed
approval expires after one second and is single-use; synthetic events do not
approve capture. The existing Main-frame, exact document/origin, grant expiry and
navigation checks remain enforced. Short holds, conflicting keys, cancellation,
hidden panes and unmount release reservations, including late IPC acknowledgements.
Older desktop hosts retain the strict Start route, not a permission bypass.
The microphone has a muted acquisition state,
the same restrained theme-accent breathing as the composer and a processing spinner. Recording/processing labels are
screen-reader-only; reduced-motion preference disables breathing. Stop and Cancel
remain accessible. Empty or Unicode punctuation/whitespace-only ASR results
show a no-speech retry notice and leave the existing draft unchanged, without sending.
Capture now prefers a same-origin bundled AudioWorklet (no inline/blob worklet URL),
with a muted ScriptProcessor fallback for hosts without usable worklets. Real DC-removed
RMS drives the themed microphone halo while the shared nine-second breathing remains.
An intentionally permissive **rough energy gate, not VAD**, requires at least 120 ms
of captured audio and 40 ms of blocks at RMS >= 0.00015 (about -76.5 dBFS). It rejects
near-digital silence, DC/stuck inputs and unusably short gestures; quiet speech-like
signals at RMS around 0.00021 pass. The same gate applies to click, pointer hold and
Ctrl+Shift recordings before inference/final upload. Initial PCM is buffered until the
gate passes; streaming may then upload to the configured local service while recording.
These low fixed thresholds deliberately prioritize retaining quiet speech over rejecting
noise. They are not adaptive speech classification: background noise/music can pass and
ASR can still hallucinate. Unicode punctuation-only output remains suppressed separately.
No VAD model is added/downloaded. A genuine optional local VAD could be evaluated later
with explicit model/license approval and quiet-speech acceptance samples; it is not
implemented or claimed here. Releases while awaiting
permission are remembered and stop capture immediately when acquisition completes.
Capture uses the actual AudioContext rate (not an assumed 16 kHz). A windowed-sinc
low-pass converts to mono 16 kHz PCM16, suppressing downsampling aliases; streaming
conversion retains phase/history across block boundaries. WAV remains the local legacy
final path for new unsaved drafts or a backend without streaming routes (404/501 only,
with an unavailable-streaming notice). Other streaming errors never silently fall back.

For existing logical sessions the [stage-1 transport](audio-streaming-backend.md) creates
an authenticated local stream, subscribes with fetch/SSE, waits for `ready`, and uploads
sequential bounded PCM chunks. SenseVoice fixed three-second windows yield accumulated
**provisional snapshots**, not token-real-time text. The popup preview is visibly distinct
from the draft; partials never mutate it. Stopping runs whole-clip offline correction,
discards the preview and appends only final recognized text to the **current** draft.
Manual edits made during capture/processing are preserved. Final text does not overwrite
or insert the provisional wording, and nothing is automatically sent. Cancellation,
stream errors or stale revisions never insert partials. No duplex, TTS queue, acoustic
endpointing or barge-in is provided by this stage. **Cancel**, Escape, window blur, hidden
page, changing Project/draft, deactivation and unmount discard capture and abort
requests, including pending microphone acquisition.
Recordings are limited to 60 seconds (the limit cancels, rather than auto-uploading).
The Project endpoint accepts at most 10 MiB, never caller-supplied paths, and deletes
its private temporary WAV after inference. There is no silent remote fallback.

TTS-only configuration still offers ASR setup. A configured remote ASR route is
reported accurately but composer recording currently supports local ASR only;
remote transcription remains available through the unified audio tool. **Change
audio setup** is available in the microphone popup after a 200 ms hover or keyboard
focus. It explicitly opens local/remote choices, whose selection submits a setup
request to the ordinary session Agent. **Refresh audio status** rechecks setup;
status errors show retry instead of pretending audio is unconfigured. Configuration
readiness does not claim inference verification. This is conventional input, not
an IME or duplex interface. Capture remains available while the assistant is thinking
and can append to an existing draft; it does not interrupt that turn or auto-send.
Only setup submission keeps request-busy, draft and attachment restrictions. Capture
is disabled for remote workdirs, pending questions and read-only conversations, and
capture/transcription are mutually exclusive. Existing send behavior is unchanged.
Capture/inference failures remain visible and do not send a message.

Implementation checks use synthetic PCM, mocked capture lifecycle, rendered state
transitions, and authenticated endpoint fixtures. They do not exercise a real
microphone or establish browser/OS capture readiness on a specific installation.

## Supported Agent tool workflow

Import `audio` or its compatible `audio_cpp` name. Both use the same Project service,
private configuration and per-task routes, not separate inference implementations.

1. `status`: inspect existing CLI/models and selected task routes.
2. `assess` with `candidate`: family, backend, platform, arch, downloadBytes; optional
   minimumMemoryBytes only with a published memoryEvidence URL. Shadow measures
   available/total RAM, free disk, CPU count, OS and architecture. Suitable means
   basic evidenced CPU capacity, **not** tested inference. GPU/driver support or
   missing model-specific RAM metadata produce unknown. Unsuitable recommends remote;
   the Agent must ask before switching, never automatically upload or fall back.
   Do not invent universal RAM thresholds or treat model download size as RAM usage.
3. Obtain approval for source, license and disk use. Resolve trusted published
   SHA-256, sizes and pinned URLs; never fabricate a digest.
4. `setup` with a `setup` object:
   - approved: true (only following approval)
   - binary: {url, sha256, bytes, entry, platform, arch}
   - model: {url, sha256, bytes, family}
   - task: asr or tts; optional backend and options.
   Binary must be an ordinary ZIP containing the exact entry, e.g.
   bin/audiocpp_cli.exe, with adjacent runtime libraries/resources included.
   Download uses the existing bundled aria2 verifier; extraction rejects traversal,
   links, special files, duplicate paths, invalid CRC, unsupported ZIP methods and
   overlarge entries. No shell installers or unverified execution. Model is a single
   GGUF, not a multi-file Python package. Paths are managed under Project Home
   `.audio-cpp`; users do not edit paths/config files.
5. Shadow probes the CLI loader catalog before model download, verifies the weight
   artifact and model-specific help, then configures the local task/route automatically.
   Config is written only after successful probes. Failed downloads/probes may leave
   verified cache files but do not register the new model. Reruns use the same managed
   paths and verified download cache. Help/catalog is not an inference probe.
6. Test a consented sample using `transcribe`/`speak` before claiming working inference.
   `status.inferenceVerified` is deliberately false: configuration is not acceptance.

ZIP only, maximum compressed archive 512 MiB, single extracted entry 512 MiB and
aggregate extracted data 2 GiB. Self-contained CPU packages are the simplest route.
Releases requiring separate CUDA runtime archives are not supported by the one-ZIP
setup action; use the skill's explicit verified import workflow instead. No install
occurs on Shadow startup. Model downloads may be large and remain approval-gated.

### SenseVoice

SenseVoice-Small Q8 family is `sense_asr`, package `sensevoice_small_q8`, file
`sensevoice-small-q8-audiocpp-v1.gguf`, repo
`FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp`. Model spec evidence revision is
`5c3fcfe748a8714216bc135476d5863084fddb72`. A revision is **not** a SHA-256 weight
digest. Resolve pinned artifact metadata and license first. Not every CLI release
has this family; setup validates the selected CLI catalog.

For the v0.9.1 Windows x64 CPU-portable release, the CLI ZIP entry is
`audiocpp_cli.exe` at the archive root. SenseVoice's default automatic chunking
requires a separate Silero VAD model directory which this package does not supply.
For a short, presegmented WAV, pass setup `options: ["--audio-chunk-mode", "none"]`
to avoid that extra dependency. Do not claim automatic VAD/long-audio readiness
from a short unchunked inference test.

## Remote API

`configure_remote` takes task and remote={baseUrl, model, apiKeyEnv?}. Explicitly
select an OpenAI-compatible `/v1` base URL; HTTPS required except loopback HTTP.
`apiKeyEnv` references an existing host secret environment variable; never place
keys in chat/tool arguments. New credential provisioning remains host-side; this
iteration does not introduce a secure credential input form. A localhost API may
need no key. Configuration makes no network request and proves no remote readiness.

`transcribe` posts multipart model/file to `/audio/transcriptions` (25 MiB input
limit); `speak` posts to `/audio/speech` requesting WAV and default voice alloy.
Responses are bounded; errors suppress provider body/transport diagnostics to avoid
secret leakage. Redirects are rejected to prevent credential forwarding. There is
no local/remote fallback. Consent to the selected destination is required before
sending audio/text. Local configure/setup selects local for that task, and remote
configure selects remote. Existing `.audio-cpp.json` v1 configs remain readable.

## Verification boundaries

Focused setup tests use synthetic ZIP/GGUF data, a mock downloader/CLI and mocked
HTTP responses. They prove Agent tool execution, verification/extraction, registration,
route selection, idempotent config and failure behavior, **not** real model inference.
UI tests prove chooser wiring/request semantics plus Vue typechecking, not browser
acceptance. Actual first-use Agent interaction, approved live downloads, host backend
compatibility and a real inference sample remain user end-to-end acceptance checks.

### Live source-service acceptance (2026-10-12)

Approved official downloads were verified and installed outside the repository in
Project Home by the actual `AudioCppService.setup` implementation, using its real
bundled aria2 downloader, ZIP extractor and CLI probes (no downloader/CLI mocks):

- audio.cpp v0.9.1 Windows x64 CPU-portable ZIP: 26,951,312 bytes;
  SHA-256 `2fccc73dc97af84da1e81c3af545fa619348a46d023ea7d927ba80bc8680d2a0`
  from GitHub release API; root entry `audiocpp_cli.exe`.
- SenseVoice Q8 GGUF at the pinned HF revision above: 254,211,200 bytes;
  SHA-256 `4dedf169f625437fb336f2959674f399819729a765e184128c0e25a6e16ff0ec`
  from the official HF model API's LFS metadata; model card license Apache-2.0.
- Actual loader catalog reported `sense_asr` ASR support. Setup registered CPU ASR
  and the local route. Rerun reused verified artifacts successfully.
- Consented public LibriSpeech fixture `6930-75918-0000` (OpenSLR SLR12,
  CC BY 4.0), from upstream audio.cpp commit
  `cf124a67cc55d8f65a9a15eec69edbff0fb212c8`, 3.505 s, 16 kHz mono,
  112,204 bytes; SHA-256
  `103c3f15eb3715ebc6243d142244128a3ac39b6bfae315baa6b8dc4a8be14aa8`.
  Local `AudioCppService.transcribe` returned
  `Concord returned to its place amidst the tents.` in approximately 1.13 s,
  matching the published reference after case/punctuation normalization.

The first inference with default options failed explicitly because the Silero VAD
model path was absent. Repeating setup with the short-sample options above resolved
that failure without downloading another model or hiding the error.

This validates real source-service setup/inference, not a reloaded production tool
or UI. The already-running runtime still exposed the older `audio_cpp` contract;
its `status` rejected the new persisted `routes` key. Restart/reload with the current
backend and repeat ordinary Agent tool calls before claiming production-session
acceptance. `status.inferenceVerified` remains false by design. TTS, automatic VAD,
long recordings, microphone capture and browser chooser acceptance were not tested.
