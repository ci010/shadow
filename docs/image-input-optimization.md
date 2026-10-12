# Model-input image optimization

Shadow optimizes eligible PNG attachments into a **lossless WebP model-input copy** using WASM codecs. It does not modify the original upload, file, or attachment reference. Smaller encoded data reduces request bytes; WebP is not a promise of better model accuracy.

## Ingress and validation

- User media built by `src/agent/message-builder.ts`: local image files and inline image data URLs are eligible.
- Local image reads through `src/tools/read.ts`: eligible; the returned MIME describes the actual model-input bytes.
- HTTP(S) image URLs are passed through; Shadow does not fetch/transcode them here.
- `imageFromBytes`, `imageFromDataUrl`, and the default `readImage` remain validation-only. Outbound attachment validation, tool-image validation, and other existing callers are not silently transcoded.
- The **original** must still satisfy the existing nonempty / **5 MiB** / **25 million pixels** checks and MIME validation. Oversized originals are rejected before optimization, even if conversion might make them fit. There is no new acceptance of huge inputs.
- Existing persisted history is not retroactively converted. Screenshots returned directly by imported/dynamic tools are not optimized by this ingress change.

## Conversion policy

Only PNGs of at least 256 KiB are candidates. There is no separate optimization pixel cap: eligible images throughout the existing 25-million-pixel input range are attempted. The optimizer skips:

- JPEG, GIF, WebP, and small PNGs;
- high-bit-depth PNGs (only 8-bit PNGs are decoded);
- animated PNGs (`acTL`);
- PNGs with ICC profiles (`iCCP`), EXIF metadata (`eXIf`), chromaticity metadata (`cHRM`), or nonstandard gamma (`gAMA` other than the usual 45455 value). Their metadata is not safely carried into the new WebP;
- malformed chunk layouts, or requests arriving while another conversion is active.

Encoding uses lossless WebP (`lossless=1`, `near_lossless=100`, `exact=1`) with no resizing or lossy fallback. The result is used only if it is **strictly smaller** than the original, is a valid WebP header, and has the same dimensions. Text/screenshots are not subjected to aggressive JPEG-style quality loss. Transparent pixel colors are preserved by the `exact` setting. Ancillary textual PNG metadata is not copied to the model-input copy; the original remains available.

## Runtime bounds and fallback

- One isolated worker per backend at a time; concurrent optimization attempts use their originals rather than build up a queue of decoded images.
- A 10-second deadline terminates the worker and falls back to the original.
- Abort signals terminate active conversion and propagate cancellation rather than substituting an original after cancellation.
- Decode/encode/initialization failures, larger output, and invalid output fall back to the already validated original.
- The worker uses a 128 MiB V8 old-generation limit; the existing input validation caps images at 25 million pixels. Larger images within that range are still attempted and may require substantially more memory. This is **not a hard process/WASM memory cap**: linear memory and external allocations can exceed the V8 heap limit. Worker termination releases its codec memory; conversion does not run on the backend event loop.

## Codec and packaging

Runtime dependencies are pinned to `@jsquash/png@3.1.1` and `@jsquash/webp@1.5.0` (Squoosh-derived WASM codecs), not native image addons. The worker explicitly loads packaged WASM bytes with Node file APIs, avoiding browser `fetch(file://...)` initialization. The portable WebP binary works through the package's JS loader even when its feature detection selects the SIMD-capable loader.

`src/utils/image-codec-worker.js` is a JavaScript build asset: the existing backend asset copier includes it in `dist/src/utils`. Standard production `pnpm deploy` includes the codec packages and their WASM assets. Verification covers compiled backend code in a production deployment outside the source checkout; an Electron installer run is not required to exercise this Node/WASM path.

Focused tests: `pnpm exec node --import tsx --test src/utils/image-optimization_test.ts src/tools/read-image_test.ts src/agent/message-builder_test.ts`.
