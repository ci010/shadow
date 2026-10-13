# Stage 1 local transcription transport

Backend contract (implemented; not a claim that voice conversation or TTS queue exists).
Uses the already selected local **audio.cpp SenseVoice** configuration. Does not download
models, use credentials, upload to a provider, accept caller paths or fall back remotely.
All routes use the existing Project gateway authorization and `Cache-Control: no-store`.
A capture belongs to one existing logical session. Session deletion, Project teardown,
SSE disconnect, DELETE, audio/ingress limits and deadlines cancel the process.
Frontend must DELETE when switching sessions or abandoning capture.

## Protocol

1. `POST /api/audio/streams`, JSON `{ "sessionId": "web:..." }`.
   HTTP 201 example:
   `{ "id": "<uuid>", "mode": "buffered-window", "windowSeconds": 3,
      "format": "s16le", "sampleRate": 16000, "channels": 1,
      "maxChunkBytes": 65536, "maxAudioSeconds": 60,
      "vad": "unavailable", "silenceGate": "digital-zero-only" }`.
2. Authenticated fetch `GET /api/audio/streams/<uuid>/events` (SSE).
   Do not assume EventSource can attach the gateway Authorization header.
   SSE headers and the first `ready` event are written **before any audio is required**.
   Read `ready` before uploading. Only one subscriber is accepted; disconnect cancels.
3. Sequential `PUT /api/audio/streams/<uuid>/audio?sequence=0`, then 1, 2, ... .
   Content-Type exactly `application/octet-stream`; body raw mono **16 kHz s16le**
   (no WAV header, no floating-point samples). Each chunk is 1..65536 bytes, even length.
   Await each response before sending the next; HTTP 200
   `{ "sequence": 1, "receivedBytes": 3200 }` acknowledges the next expected sequence.
   Backpressure is propagated to CLI stdin. An ambiguous failed upload is not retryable
   without cancelling/restarting: do not duplicate samples.
4. `POST /api/audio/streams/<uuid>/finish` returns HTTP 202 `{ "accepted": true }`.
   Read SSE until final/error/cancelled; EOF alone is not successful transcription.
5. `DELETE /api/audio/streams/<uuid>` returns `{ "cancelled": true }` after process/job
   cleanup. UUID is opaque and scoped to the authorized Project; unknown ID is 404.

Every SSE message has `event: transcript`, `id: <revision>`, and JSON `data`, e.g.:

- `{ "type": "ready", "revision": 0 }`
- `{ "type": "partial", "revision": 1, "text": "First window." }`
- `{ "type": "partial", "revision": 2, "text": "First window.Second window." }`
- `{ "type": "final", "revision": 3, "text": "The corrected whole clip.\r\n" }`
- `{ "type": "error", "revision": 3, "code": "final_failed" }`
- `{ "type": "cancelled", "revision": 3, "code": "subscriber_disconnected" }`

Revisions are numeric and strictly increasing after ready. **Every partial is an
accumulated snapshot**, not a token or append delta. The server appends CLI window deltas
without inventing spaces. **Final replaces the entire provisional transcript** and
preserves the existing offline transcription text exactly, including whitespace.
Final inference uses the original configuration snapshot; changed configuration causes
an error rather than a route/model switch. No `final` follows cancellation/error.
A digital-zero/empty clip returns final `text: "", noSpeech: true`; this is not VAD.

Errors: HTTP 401 unauthorized, 400 malformed/session/PCM, 404 unknown stream,
409 unsupported model/remote route/incompatible options/order/duplicate subscriber,
413 size or ingress failure, 415 wrong media type, 429 busy, 503 Project closing.
JSON errors contain `error`, optionally `code`. Error events redact CLI diagnostics:
`unsupported_or_unavailable`, `stream_failed`, `final_failed`.
Cancellation codes include `cancelled`, `capture_timeout`, `inference_timeout`,
`session_closed`, `project_closed`, `subscriber_disconnected`, `audio_limit`,
`text_limit`, `ingress_failed`.

Bounds: one active Project stream (shares busy state with legacy WAV ingress), 60 seconds
PCM (1.92 MB), 120 seconds capture, 120 seconds finishing, 10 seconds per ingress body,
64 KiB chunk, 1 KiB create JSON, 1 MiB CLI output, 65536 transcript characters. A terminal
record is retained until next create or Project close, permitting terminal SSE delivery.
No resumption/multiple subscribers are supported. Start a fresh capture after disconnect.
CLI streaming inference and offline correction do not overlap. The shared AudioCppService
also rejects concurrent agent-tool ASR/TTS while the stream/final correction owns its
inference lease, and releases that lease only after process/job cleanup.

## Actual capabilities and verification

Installed v0.9.1 `sense_asr` advertises offline/streaming. Its persistent stdin route is:
`--mode streaming --audio - --input-format s16le --input-rate 16000
 --input-channels 1 --audio-chunk-mode fixed --audio-chunk-seconds 3`.
stdout contains `partial_text=<window delta>` and terminal `text_output=...` lines.
The backend uses only partial_text; terminal CLI streaming output is **not** final
whole-clip correction. This is fixed-window buffered latency, **not token-real-time**.
The currently selected offline `--audio-chunk-mode none` is retained for final inference;
streaming owns chunk/transport options and rejects incompatible output/log flags.
No separate streaming model or speculative replacement is needed for stage 1.

Measured on this host, existing approved public LibriSpeech 6930-75918-0000 (3.505 s),
CPU SenseVoice Q8, one-second chunk simulation, stdin kept open:

- First partial at 2811 ms, **before EOF**: `Concord returned to its place amidst.`
- EOF tail: `And.`; cumulative provisional differs from whole-clip correction.
- Final at 8360 ms total including simulated capture/tail wait and second inference:
  `Concord returned to its place amidst the tents.\r\n`.

An additional live test exercised the actual authenticated-route middleware/HTTP-shaped
Hono requests and SSE transport (synthetic fixture authorizer, no external server): ready
arrived before upload; cumulative partial at 2825 ms before finish, tail at 4242 ms,
whole-clip corrected final at 5323 ms. Silence stdin also finished successfully.

`stream-live_test.ts` is opt-in via `SHADOW_AUDIO_LIVE_PROJECT` and
`SHADOW_AUDIO_LIVE_SAMPLE`. Uses existing Project config and existing public PCM16 WAV;
downloads nothing, never records a microphone. Timings are sample/host measurements,
not a general performance guarantee. Normal tests use synthetic subprocess/PCM fixtures.

SenseVoice documents Silero VAD through `sense_asr.vad_model_path`, but no approved VAD
model is configured here. Fixed windows are honest; RMS frontend gates and the backend
exact-zero gate are **not** genuine speech detection. Non-speech noises/quiet speech
are passed to ASR; do not promise automatic acoustic endpointing/no-speech classification.
References: [audio.cpp v0.9.1 usage](https://github.com/0xShug0/audio.cpp/blob/v0.9.1/docs/usage.md)
and [v0.9.1 ASR](https://github.com/0xShug0/audio.cpp/blob/v0.9.1/docs/asr.md).
Stage 2 conversation/TTS/barge-in is not implemented by these routes.
