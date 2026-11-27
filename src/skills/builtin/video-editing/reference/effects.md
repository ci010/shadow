# Composition profile v1

Keep the original OTIO as the edit. Read its `/overview`, `/effects`, `/transitions` and `/diagnostics` projections; a structurally readable unsupported effect is not renderable. Unknown effects, parameters or combinations fail explicitly. Never insert arbitrary FFmpeg expressions.

## Effects

Put an effect in a clip's `effects` array:

```json
{"OTIO_SCHEMA":"Effect.1","effect_name":"shadow.opacity","metadata":{"shadow":{"profile":"opacity","value":0.5}}}
```

Names and profiles must match exactly. At most one of each profile per clip:

- Video/image `opacity`: `value` 0..1, multiplying source alpha.
- Video/image `transform`: `x`,`y` -2..2 in output-width/height units, `scale` 0.01..4; defaults 0/0/1. This is static translation/scale, not rotation or keyframes.
- Video/image `crop`: `left`,`top`,`right`,`bottom` 0..0.99 fractions of source edges, default 0. Opposite edges must sum to less than 1.
- Video/image `color`: `brightness` -1..1, `contrast` 0..2, `saturation` 0..3, defaults 0/1/1. No HDR/color-management claim.
- Audio-track clip `volume`: `value` 0..16, default 1.
- Audio-track clip `audioFade`: `in`,`out` seconds, default 0, clip-local; their sum must fit its duration.

Replace both `effect_name` and `metadata.shadow.profile` when choosing another profile. Disabled effects, duplicate profiles, composition effects and time warps are not supported. Preserve unrelated metadata. Order/interaction is determined by the installed compiler; do not assume arbitrary plugin semantics.

Video layers retain alpha during composition, then flatten onto black for H.264 MP4. MP4 does not retain an alpha channel. Use explicit Audio tracks for controlled mixing/fades; a visual transition is not an implicit audio crossfade.

## Transitions

Between two adjacent Video clips:

```json
{"OTIO_SCHEMA":"Transition.1","transition_type":"SMPTE_Dissolve","in_offset":{"OTIO_SCHEMA":"RationalTime.1","value":12,"rate":24},"out_offset":{"OTIO_SCHEMA":"RationalTime.1","value":12,"rate":24}}
```

For incoming picture revealed left-to-right, use `transition_type:"Custom"` with `metadata:{"shadow":{"profile":"wiperight"}}`. These are the supported kinds, not a generic transition registry.

Offsets are source handles around the existing cut: `[cut-in_offset,cut+out_offset)`. They do not add time to the edit. Incoming media needs earlier frames and outgoing media later frames. Preserve source/available ranges and validate actual handles with `plan`; never fake a handle by duplicating a frame. Cuts, offsets and preview boundaries must align to the timeline rate.

Current endpoints must be opaque, with matching display aspect ratios and no opacity-reducing/crop/transform effects. Alpha-capable endpoint formats may be conservatively rejected even if visually opaque; RGB PNG is supported, RGBA PNG is not an opaque endpoint. Other overlay tracks may still use alpha. Nested Tracks, clipped/overlapping transitions, unsupported kinds and audio transitions fail rather than approximate. Do not claim general transparent-endpoint RGBA interpolation.

## Accurate preview handoff

Explicitly run the preview command with `--manifest <timeline>.preview.json` and a new MP4 path. The manifest is tied to exact source bytes; reopen/refresh the OTIO Viewer to load it. Sidecar and video must share an authorized owner/root with the timeline. Do not hand-author an unrelated video manifest and call it a checked preview.

If the fixed sidecar name already exists, preserve it until replacement is authorized; the command never silently overwrites it. A manifest-write failure can leave a completed MP4: inspect the error and actual files before retrying. Source edits invalidate the old hash. Missing, stale, unsupported or out-of-interval previews must not fall back to a highest-layer source image as though it were the composite. Review references distinguish the selected source element from the rendered picture and its decoded PTS. Listen to the rendered soundtrack when audio matters.

VP8/VP9 WebM decoding requires the installed FFmpeg's alpha-preserving libvpx decoder. Do not retry with the native decoder to hide a missing-capability error: that can silently make transparent footage opaque. `plan` can accept explicit installed `--ffmpeg`/`--ffprobe` paths and checks selected-stream duration rather than container duration. Unknown stream bounds or network/UNC/device paths fail explicitly; do not work around them by fetching on another device or fabricating a longer source range.
