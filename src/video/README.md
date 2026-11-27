# OTIO video compiler (v1)

`pnpm exec node --import tsx scripts/video.ts --help` describes the CLI.
Product adapters can call `runVideoCli(args, {signal})` and serialize its returned
receipt. No provider/tool loop, Electron, or renderer dependency is required.

1. `init edit.otio --duration 5 --rate 24` creates a no-clobber gap timeline.
2. Edit the OTIO JSON directly. Keep arbitrary metadata; the compiler never
   serializes its derived model back over the source.
3. `plan edit.otio` (alias `validate`) resolves/probes media and returns SHA-256
   `revision`, visible picture spans, audio policy, and asset information.
4. `preview edit.otio --output preview.mp4 --revision HASH --start 0 --end 2`
   uses the same compiler as `export edit.otio --output final.mp4 --revision HASH`.
   Preview defaults to 640x360; export to 1280x720. Both permit even
   `--width`/`--height` 16..3840. No automatic overwrite.

Tools come exclusively from `--ffmpeg PATH`, `--ffprobe PATH`, or existing PATH.
There are no automatic downloads/installations. Missing tools produce actionable
errors. These commands execute on the caller's device using its authorized local
filesystem access, not an OS sandbox, and do not resolve remote workdirs on Main.
Relative media paths are relative to the OTIO file; absolute paths and local
file URLs are accepted. Network URLs, playlists and unknown extensions are
rejected; demuxers are explicitly selected, protocols limited to file/pipe.

## Semantics and explicit limitations

- Uses `src/shared/otio-model.ts`, identical to monitor time projection. Source
  positions subtract `available_range.start`, including nested source trims.
- Enabled Video tracks use opaque highest-layer hard-cut picture spans; gaps
  reveal lower layers, otherwise black. Not alpha compositing. Images letterbox
  and hold; videos scale/letterbox and convert to timeline FPS, H.264 yuv420p.
- Enabled Audio tracks suppress embedded video audio even if empty; their first
  audio streams mix additively without normalization (may clip). Otherwise only
  visible video spans contribute embedded audio. Output is stereo AAC 48kHz.
- Effects, time warps, transitions, unknown active items/tracks/media references,
  out-of-media source ranges and unsupported placement fail explicitly. All
  video cuts and interval endpoints must be whole timeline frames; no hidden
  per-span rounding. Rates 1..120, duration <=24h, <=256 active clips.
- Supported extensions: mp4/mov/m4a, mkv/webm, wav/mp3/flac/ogg, png/jpg/jpeg/webp.
  First video/audio stream only. No stream selection, HDR/color-management
  fidelity guarantee, animated-image timing, titles, alpha blend, codecs other
  than H.264/AAC output, or Three renderer. Three integration: render the shot
  first and reference the resulting local MP4 or static image with an OTIO
  ExternalReference and ordinary source_range.
- Preview/export share all filters, timeline alignment and audio policy.
  An actual decoded output-frame count must match the requested interval before
  publication; receipt contains frames, source revision and audio policy.
- Revision is the exact OTIO bytes hash, checked before and after render. It is
  not a lock or media content hash: callers must not mutate media during render.
  Source change discards output. Publication uses atomic no-clobber hard-link on
  the destination filesystem. Filesystems without hard-link support fail safely.
- Output always includes a stereo AAC stream, using silence wherever no audio
  contributes. Probe processes have a 60-second deadline; encoder/output frame
  verification have a 30-minute deadline. A timeout is a failure, never success.
- Temp files live only in a unique `.shadow-video-*` directory beside the
  destination, removed on failure/success/handled abort. Spawn uses argv, never
  a shell. Abort terminates then escalates to SIGKILL and awaits close. An OS
  crash/SIGKILL can leave the uniquely named temp directory for manual cleanup.

Run `pnpm exec node --import tsx --test src/video/video_test.ts` for unit and
real-media smoke tests. Smoke tests skip only if existing ffmpeg/ffprobe cannot
be executed; they never install tools. `TEST_FFMPEG`/`TEST_FFPROBE` can select
explicit existing binaries for tests.
