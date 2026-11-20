# Three viewer: Electron/WebGL checks

Run from the repository root with its pinned Node and installed workspace dependencies:

```sh
node --import tsx scripts/three-viewer-check/run.mjs product
node --import tsx scripts/three-viewer-check/run.mjs ui
node --import tsx scripts/three-viewer-check/run.mjs worker
node --import tsx scripts/three-viewer-check/run.mjs baseline
```

The runner serves an ephemeral loopback Vite origin and starts repository Electron with a fresh temporary profile. It copies `examples/three-playground/cube-stand` into that temporary directory; tests edit only the copied `stand.mjs`, then restore it. Downloads and caches stay in the same disposable directory. The runner mounts selected production HTTP handlers on its temporary host; it never starts or connects to a full Shadow runtime, an existing user profile, or a production workspace. The fixture has 26 selectable cubies and seven selectable stand pieces, including four claws and a shader-bound badge.

## Product viewer measurements

Host: macOS 26.4.1 ARM64, Apple M2 Pro (10 logical cores), Node 24.22.0 / Vite 8.2.2. Renderer: Electron 44.1.1 / Chromium 152.0.7977.65, Three r180, WebGL 2, `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)`, DPR 1, 960 × 680 CSS-pixel canvas. These are one run's observations, not performance budgets.

- **Repeated:** 2,048 selectable meshes, one shared geometry, 206,004-byte GLB, 2,048 draw calls during camera movement. Last click selected one mesh; last box selected 1,957 meshes.
- **Distinct:** 768 selectable meshes and 768 distinct geometries, 1,406,676-byte GLB, 768 draw calls during camera movement. Last click selected one mesh; last box selected 718 meshes. The distinct workload stays below the viewer's 1,024-primitive limit.

Time in milliseconds, **median / p95 / max** (upper middle for an even-sized median; p95 uses nearest rank and equals max for these small reload samples):

| Operation | Repeated | Distinct |
| --- | ---: | ---: |
| Wheel zoom, CPU render submission (51 frames) | 6.60 / 8.40 / 8.90 | 6.40 / 7.10 / 7.30 |
| Inter-render cadence (50 intervals) | 50.00 / 51.70 / 51.90 | 50.00 / 50.70 / 52.00 |
| Click dispatch to observed selection (10) | 5.21 / 9.61 / 9.61 | 3.20 / 9.16 / 9.16 |
| Box mouse-up to observed selection (10) | 9.05 / 18.88 / 18.88 | 4.48 / 10.48 / 10.48 |
| Hot replacement: load + two animation frames (5) | 33.10 / 36.00 / 36.00 | 33.30 / 47.80 / 47.80 |

The benchmark mounts production `ThreeViewer` and uses Chromium input dispatch in Electron for real wheel and pointer handling. The camera measurement times real renderer submission, not GPU completion or display latency. Inter-render cadence includes waiting for input acknowledgement plus a 17 ms pause per input; it is not an FPS estimate. Selection timings include Chromium dispatch and observation, but not the time spent drawing the rectangle. Hot replacement alternates two prebuilt GLBs with one translated mesh and distinct versions; it tests viewer replacement, not filesystem polling or source compilation. The workloads use different object counts, so the results do not isolate geometry sharing as a single variable.

`baseline` is a separate stock-Three diagnostic: 2,048 meshes each, with either one geometry or 2,048 unique geometries. It performs real WebGL draws, raycasts and projected-center queries, and downloads the unchanged fixture for a stock `GLTFLoader` round trip. It is not a test of Shadow's pointer, worker or reload pipeline.

`worker` passed independently of Vue: the real app Worker received a snapshot from the production session HTTP route, handled a conditional 304, built through QuickJS/WASM, and downloaded a 76,340-byte GLB that stock `GLTFLoader` decoded with 33 stable IDs.

## UI integration boundary


`ui` mounts the real `FilePreviewModal` and `GltfFilePreview`, and sends HTTP requests to production `sessionsApiPlugin`, `WebChannel`, and `GltfCaptureBridge` mounted on an isolated Hono host. The fixture supplies a synthetic owner, one session backed by managed temporary storage, a draft sink, and a test driver in place of the model/turn loop. The app opens via a fixture button rather than the production file tree. It does not exercise production owner credentials, the full gateway/desktop backend, session persistence/realtime, or inference.

The automated Electron run passed:

1. Opened the marker, switched to **Back**, and dragged a real mouse rectangle over the stand. **Add to chat** produced seven stand references (base, pedestal, badge and four claws), all stamped with the opening build version. The harness deactivated the preview without unmounting it, then submitted the composed references through `/api/chat/send`. The real capture bridge admitted that owner Web turn.
2. Observed the production snapshot route return a conditional `304` without another Worker. The host called the real `WriteTool` to exact-replace one expression in the temporary `stand.mjs`, raising only the rear claws. The build and rendered PNG changed; the camera pose stayed unchanged.
3. The host called `CaptureViewTool` in that same turn. `afterVersion` refused the previous model before the edit; after reload the tool returned the exact new version and a transient `image_url` with inline PNG data, not a local path. **Current** and independent **front** both decoded to 1040 × 527 PNGs. Their images and camera poses differed, front capture did not move the live camera, and the captured selection still included both rear claws.
4. Exact-replaced an expression with invalid JavaScript in the same file. The error appeared while the successful build, camera and selection stayed available. Repair cleared the error and recovered the edited image. An actual Electron download reopened in stock `GLTFLoader`: 76,340 bytes, 33 stable IDs, rear-left claw center at Y = 0.76 instead of 0.58. Decoding the GLB does not verify in-view shader appearance.

One run yielded four HTTP `200` snapshots (host route plus response-body read: 7.94–11.28 ms) and one `304` (6.05 ms); these are server measurements, not round trips. The Worker started 182 ms after the first changed snapshot response (one debounce observation, excluding the ~1 s poll phase). The successful initial, edited and repaired builds took 239, 184 and 177 ms from Worker construction to `ThreeViewer.load` resolution. Those intervals include Worker/WASM startup, sandbox evaluation, GLB export/transfer/hash and viewer validation/loading, but not the preceding snapshot request, poll/debounce, or subsequent display/PNG capture. The fourth Worker intentionally failed syntax validation and never reached the viewer. No manual UI verification is included in these results.
