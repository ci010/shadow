# OTIO video compiler — explicit Shadow profile v1

`pnpm exec node --import tsx scripts/video.ts --help` describes the CLI.
Product adapters call `runVideoCli(args, {signal})`; preview and export use the
same compiler. This is a whitelist, **not arbitrary OTIO/FFmpeg support**.

1. `init edit.otio --duration 5 --rate 24` creates a no-clobber gap timeline.
2. Edit the OTIO JSON directly. The compiler never writes its derived model over
   the authored document. Revision is SHA-256 of the original UTF-8 bytes.
3. `plan edit.otio` / `validate edit.otio` resolves/probes media, returning revision,
   picture spans (a navigation/embedded-audio projection, **not the composition**),
   effects/transitions, `requiresCompositePreview`, diagnostics and assets.
4. `preview edit.otio --output preview.mp4 --revision HASH --start 0 --end 2`
   uses the same compiler as `export edit.otio --output final.mp4 --revision HASH`.
   Preview defaults to 640x360; export to 1280x720. Both permit even
   `--width`/`--height` 16..3840. Existing outputs are never overwritten.

Tools come exclusively from `--ffmpeg PATH`, `--ffprobe PATH`, or existing PATH.
No automatic downloads/installations. Commands execute on the caller's device
using its filesystem authority, not an OS sandbox, and never map remote paths
onto Main. Relative media paths resolve beside the OTIO file; absolute paths and
local file URLs are accepted. Network URLs/playlists/unknown extensions fail.
Demuxers are explicitly selected; protocols are limited to file/pipe.

## Shared browser-safe contract

`src/shared/otio-effects.ts` exports `OTIO_PROFILE_VERSION = 1`,
`OTIO_PROFILE_EXAMPLES`, `ProfileEffect`, `ProfileTransition`,
`OtioPreviewManifest`, and `prepareOtioProfile(text)`.
The latter returns `{model,effects,transitions,requiresCompositePreview,diagnostics}`.
Maps use JSON-pointer node IDs matching the ordinary parser. It validates known
effects, strips them from a private clone, then reuses `parseOtio` for timing;
source text is never rewritten. Unknown/malformed/disabled effects throw with a
pointer and reason, including on disabled clips. Successful diagnostics are empty.
Consumers may catch these errors to show an explicitly unsupported document.
Media existence, pixel format and real source length require backend `plan`.
Composition preview is conservatively requested for any effects/transitions,
overlapping video clips (including nested Stacks), or alpha-capable extensions
PNG/WebP/MOV/MKV/WebM. This is not a proof of media opacity.
Input remains bounded by the ordinary parser's 8 MiB / 20k nodes / depth 64 limits;
profile lookups use node and adjacency maps, overlap detection uses a sorted scan.

### Effects

Clip-only `Effect.1`, exactly named `shadow.<profile>`; example:

```json
{"OTIO_SCHEMA":"Effect.1","effect_name":"shadow.opacity","metadata":{"shadow":{"profile":"opacity","value":0.5}}}
```

Whitelisted `metadata.shadow` fields (all finite numbers, defaults below):

- `opacity`: `value=1` in 0..1. Multiplies the source alpha.
- `transform`: `x=0,y=0` in -2..2 of canvas width/height; `scale=1` in .01..4.
  Uniform scale of the aspect-fit canvas size, centered plus translation. No rotation.
- `crop`: `left=0,top=0,right=0,bottom=0` in 0...99, fractions of source dimensions;
  opposing sums must be <1. Crop precedes aspect-fit scaling; not a canvas mask.
- `color`: `brightness=0` in -1..1, `contrast=1` in 0..2,
  `saturation=1` in 0..3, using FFmpeg eq semantics, preserving alpha.
- `volume`: `value=1` in 0..16, **Audio-track clips only**.
- `audioFade`: `in=0,out=0` seconds, **Audio-track clips only**; sum must not exceed
  projected clip duration. Linear clip-local fade in/out. No keyframes/time warps.

At most one of each profile per clip. Visual profiles require Video clips.
Effects execute in authored array order before final aspect-fit scale/translation;
transform only sets final geometry. Crop/color/opacity preserve source alpha.
Unknown parameters, strings, filter expressions, profiles, effect names/schemas,
`enabled:false`, composition effects, rotation and automation curves fail explicitly.
Extremely small crops that produce zero decoded pixels fail FFmpeg validation.

### Transitions

Supported only between adjacent Video clips in one Track:

- Standard `Transition.1`, `transition_type:"SMPTE_Dissolve"`; optional
  `metadata.shadow:{"profile":"dissolve"}`.
- `Transition.1`, `transition_type:"Custom"`,
  `metadata.shadow:{"profile":"wiperight"}` reveals incoming from left to right.

Both require ordinary RationalTime `in_offset` and `out_offset`, nonnegative with
positive sum. For nominal cut C the interval is **[C-in_offset,C+out_offset)**.
Outgoing decodes postroll through C+out_offset; incoming decodes preroll starting
at C-in_offset. The cut does not shorten either clip or the timeline. Source
handles must fit both available_range (when declared) and probed media length.
Offsets/placements must land on the timeline frame grid. Edge/clipped/disabled
transitions, gaps as endpoints, overlapping transition intervals fail.

**Endpoint restriction:** transitions currently require proven opaque decoded
pixel formats, square unrotated pixels, matching source aspect ratios, and no
endpoint transform/crop or opacity other than 1. Color effects are allowed.
Alpha-capable/unknown decoded formats (including RGBA PNG even if its alpha happens
to be all 255) fail with the endpoint pointer; opaque RGB PNG is supported.
This deliberately rejects alpha-endpoint crossfades rather than pretending an
alpha-over ramp is a premultiplied RGBA crossfade. Ordinary alpha tracks may be
above or below an opaque transition track. `slide`, `fadeblack`, other wipes,
audio transitions and arbitrary transition/filter names are explicitly unsupported.

## Composition / audio / limits

- Video tracks and clips inside nested Stacks composite bottom to top using RGBA
  intermediates and transparent aspect-fit margins. Gaps reveal lower layers;
  the final background is black and output flattens to H.264 yuv420p. No duplicate
  rendering of descendants: **nested Tracks are explicitly rejected**.
- Enabled Audio tracks suppress embedded video audio even when empty. Their first
  audio streams mix additively without normalization (may clip). Otherwise only
  highest visible video hard-cut spans contribute embedded audio: visual alpha or
  transitions do **not** imply automatic audio crossfades. Stereo AAC 48kHz always
  exists, with silence when no source contributes.
- All video cuts, transition handles and render boundaries must be whole timeline
  frames; no hidden per-span rounding. Rates 1..120, duration <=24h, <=256 active
  clips for backend rendering (not a limit on shared structural/VFS parsing).
- Supported extensions: mp4/mov/m4a, mkv/webm, wav/mp3/flac/ogg, png/jpg/jpeg/webp.
  Single-frame images only; first video/audio stream only. No stream selection,
  HDR/color-management fidelity guarantee, animated-image timing, titles, other
  output codecs or Three renderer. Three shots must first become local media.
- Interval rendering deliberately compiles from timeline zero through interval
  end, then trims the composition and mixed audio. Effect/transition clocks are
  therefore identical to full export; late previews can be expensive. Independent
  lossy H.264/AAC encodes need not be byte/pixel-identical at GOP/packet boundaries.
- Decoded frame count must match the requested interval before publication. Source
  hash is rechecked afterward; changed OTIO discards output. Hash is not a lock or
  media-content hash: callers must not mutate source media during rendering.
- Publication uses atomic no-clobber hard-link beside the destination; unsupported
  filesystems fail safely. Probe deadline is 60s; encoder/frame verification 30m.
  Abort terminates, escalates to SIGKILL, and awaits close. Temporary unique
  `.shadow-video-*` directories are removed on success/failure/handled abort;
  OS crash/SIGKILL may leave them for manual cleanup. Spawn uses argv, never shell.

## Explicit preview receipt

Only `preview ... --manifest NEW.json` writes a browser-safe sidecar. There is
no automatic detection or default generation. The explicit filename may be
`edit.otio.preview.json`. Export does not accept this flag. Example:

```json
{"version":1,"profileVersion":1,"sourceSha256":"<64 lowercase hex characters>","media":"preview.mp4","start":0,"end":2,"rate":24,"frames":48}
```

`media` is the MP4 path relative to the manifest directory, slash-separated.
The video is rendered, verified and published **first**, then the manifest is
written to a synced private temporary file and atomically published. Creation is
no-clobber. To replace the fixed `<timeline>.preview.json` entry, explicitly pass
`--manifest-revision OLD_MANIFEST_SHA256`; the previous successful command returns
`manifestRevision`. Only a valid previous manifest at that fixed path can be
replaced. An exclusive cooperative lock serializes publishers; old-manifest and
source hashes are checked again before publication. This is not a CAS against
external editors or owner authorization. Locks are not automatically stolen.

If publication fails, the old entry remains intact and the command **retains the
finished video**, reporting its actual path. Existing OTIO/MP4 files are never
overwritten. No implicit artifact cleanup on receipt failure. Refresh the Viewer
after successful publication; passive reads never start an encoder.

## Revision-safe edits and exact output frames

`edit SOURCE.otio --patch PATCH.json --revision SOURCE_SHA256 --output NEXT.otio`
applies a bounded JSON Patch subset (`add`, `remove`, `replace`, `test`) to the
original JSON, preserving unknown metadata. It validates the complete profile,
rechecks source bytes, then publishes a synced new file atomically with no
clobber. Both timelines must share an actual parent directory to preserve relative
media paths. This does not lock the source against an external writer, probe media
or establish source-handle validity. Re-read new pointers and run `plan` afterward.

For fractional rates use `init --frames N --rate RATE`; `--duration` and `--frames`
are mutually exclusive. `plan` exposes `timelineFrames`, `assets[id].timing` and
conditional audio-policy `warnings`. Input timestamps are sampled to the constant
output rate, not optical-flow retimed. Unknown selected-stream duration remains
an error. The short CFR regression fixtures do not establish full VFR or color
fidelity. Explicit overlapping audio remains additive and unnormalized; visual
transitions do not automatically crossfade embedded sound.

Run `pnpm exec node --import tsx --test src/video/*_test.ts`. Tests include actual
alpha/color/geometry pixels, dissolve/wipe samples and decoded handles, interval
frame correspondence, gain/fade RMS, rejection/receipt/no-clobber/cleanup behavior.
Some legacy media tests skip if existing ffmpeg/ffprobe cannot run; the timebase
and repeated-preview workflow regressions fail instead. Check skip counts rather
than assuming a passing command exercised media. No tools are installed.
`TEST_FFMPEG`/`TEST_FFPROBE` select existing binaries.

## Decoder and path boundary hardening

VP8/VP9 input always uses the existing FFmpeg build's `libvpx`/`libvpx-vp9` decoder so native WebM decoding cannot silently discard alpha. `plan`/`validate` accept explicit `--ffmpeg` as well as `--ffprobe` and preflight that decoder; missing capability fails rather than falling back. All VP8/VP9 sources are conservatively alpha-possible for transition-endpoint validation, including missing AlphaMode tags.

Source and handle bounds use the selected stream's `duration`, then `duration_ts * time_base`, then same-stream DURATION end timestamp minus a known `start_time`/`start_pts` origin. Unknown usable duration fails closed. Longer audio/container duration cannot justify a shorter video stream (or vice versa); actually mixed audio has its own check.

Source OTIO, media, init, output and manifest paths are checked before filesystem access for explicit UNC/network/device forms and remote file-URL hosts. Local references and localhost file URLs remain supported for media. This is path preflight, not an OS sandbox or a claim that arbitrary pre-mounted filesystems are non-network storage.
