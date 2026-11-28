# OTIO composition profile v1

Shadow supports a validated, deliberately bounded OTIO rendering profile. The `.otio` file remains the source of truth. No arbitrary FFmpeg expressions, shaders, plugin names or executable code are accepted as effect parameters. Unknown or malformed effects are errors, not silently dropped edits.

The browser-safe `src/shared/otio-effects.ts` prepares effects/transitions for the renderer, Viewer and read-only VFS. It normalizes a private copy for the shared structural parser and never rewrites the authored file. `edit.otio/overview` reports profile support and whether composite preview is required; `/effects`, `/transitions` and `/diagnostics` expose details without probing media. A structurally inspectable unsupported profile is not permission to render it.

## Clip effects

Use `Effect.1`, the exact name and matching `metadata.shadow.profile`:

```json
{
  "OTIO_SCHEMA": "Effect.1",
  "effect_name": "shadow.opacity",
  "metadata": { "shadow": { "profile": "opacity", "value": 0.5 } }
}
```

Place the object in a clip's `effects` array. The supported names are `shadow.opacity`, `shadow.transform`, `shadow.crop`, `shadow.color`, `shadow.volume` and `shadow.audioFade`. Each corresponds to the profile name after `shadow.`. Duplicate profiles on one clip, stream-inappropriate effects, unsupported parameters and disabled effects are rejected rather than guessed.

| Profile | Fields | Meaning |
| --- | --- | --- |
| `opacity` | `value` 0..1, default 1 | Multiply original video/image alpha |
| `transform` | `x`, `y` -2..2, default 0; `scale` 0.01..4, default 1 | Translation in output-width/height units and centered aspect-preserving scale |
| `crop` | `left`, `top`, `right`, `bottom` 0..0.99, default 0 | Fractions removed from source edges; remaining width/height must be positive |
| `color` | `brightness` -1..1; `contrast` 0..2; `saturation` 0..3 | Basic display-referred adjustment, defaults 0/1/1; not HDR/color-management fidelity |
| `volume` | `value` 0..16, default 1 | Audio-track clip gain |
| `audioFade` | `in`, `out` seconds, default 0 | Audio-track clip-local fades; combined duration must fit the clip |

These are static parameters, except for clip-local audio fades. This is not arbitrary keyframe animation, a third-party plugin API or a generic time-warp system. Track/composition effects are not part of this profile.

## Transitions

A transition lives between adjacent clips in a Video track. Standard dissolve:

```json
{
  "OTIO_SCHEMA": "Transition.1",
  "transition_type": "SMPTE_Dissolve",
  "in_offset": { "OTIO_SCHEMA": "RationalTime.1", "value": 12, "rate": 24 },
  "out_offset": { "OTIO_SCHEMA": "RationalTime.1", "value": 12, "rate": 24 }
}
```

For a wipe revealing the incoming image from left to right, use `transition_type: "Custom"` and `metadata: {"shadow":{"profile":"wiperight"}}` with the same offsets. Names are a whitelist, not FFmpeg filter strings. Other transition kinds are rejected.

**Offsets are handles around the cut, not extra timeline duration.** The transition spans `[cut - in_offset, cut + out_offset)`. The incoming clip needs earlier source media and the outgoing clip needs later source media. The planner checks handles against the authored available range and actual local media. Cuts, offsets and preview boundaries must be on the output frame grid.

This revision limits transition endpoints to confirmed opaque, square-pixel, unrotated media of matching aspect ratio without opacity-reducing or geometry effects. It rejects alpha/half-transparent endpoints instead of pretending fade-over is general RGBA interpolation. Other tracks may still use alpha compositing. Nested Tracks, transition overlap/clipping, unsupported transition kinds and audio transitions are rejected. Normal alpha layers, source PNG/WebP alpha and opacity are composited bottom-to-top before flattening to the output's black background; MP4 output itself does not preserve alpha.

## Accurate preview

Generate a preview explicitly with the same compiler as final export. A manifest associates it with the source revision:

```sh
node dist/src/index.js project-video preview edit.otio --revision SHA256 --start 0 --end 4 --output preview-v2.mp4 --manifest edit.otio.preview.json
```

The versioned manifest contains the exact OTIO SHA-256, output interval/rate/frame count, and a media path relative to the manifest. The MP4 must use a new path. Sidecar creation is no-clobber by default; to update the fixed `<timeline>.preview.json` entry, explicitly pass `--manifest-revision OLD_MANIFEST_SHA256` using the previous successful command's `manifestRevision`. Updates validate the previous manifest and use a cooperative publisher lock with atomic publication; a stale hash or lock conflict does not replace the old entry. This protocol does not lock out external editors. Refresh the Viewer after successful publication. Reading a timeline or sidecar never starts FFmpeg. A manifest-publication error is reported even if the completed video remains available; it is not permission to overwrite an older preview.

The Viewer must not show highest-layer cuts as if they were a faithful preview of transparency/effects/transitions. It uses a valid same-owner rendered preview when available, otherwise reports that composite preview is required. Rendered audio comes from the MP4, not a second mix of source clips. Out-of-range, stale or invalid previews cannot be silently substituted for the current edit. This does not enable cross-device streaming or bypass existing attachment/archive media restrictions.

Interval previews currently compile from timeline zero and trim the finished composition so transition and effect clocks match full export. This prioritizes sampling consistency over late-range seek performance. Without explicit Audio tracks, embedded sound still follows the structural visible-video selection and cuts; visual transitions do not automatically crossfade audio. Author explicit Audio clips with volume/fade profiles for controlled sound.

VP8/VP9 input uses an alpha-preserving libvpx decoder, not a native decoder that can silently discard WebM alpha. The installed FFmpeg must expose the required decoder; otherwise planning/rendering fails explicitly. Source/handle checks use the selected video or audio stream, not the longer container duration. A stream whose usable duration cannot be established is rejected. Explicit UNC/network/device paths and remote file-URL hosts are not local media references, even on Windows.
