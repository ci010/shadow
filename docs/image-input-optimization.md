# Model-input image optimization

Shadow optimizes eligible PNG attachments into a **lossless WebP model-input copy** using WASM codecs. It does not modify the original upload, file, or attachment reference. Smaller encoded data reduces request bytes; WebP is not a promise of better model accuracy.

## Unified new-message guard and validation

`prepareNewMessageImages()` in `src/providers/new-message-images.ts` is the shared preparation policy for **newly admitted session content**, before it becomes model history and reaches a provider. It is called by `BaseSession` persistence, channel-history archive admission, and the transient full-tool-result injection path.

- User attachment building and `read` now validate/read original images; they no longer select compression independently.
- The guard covers new user images and all normal tool-result images, including computer/MCP/dynamic tool screenshots. Original upload files and saved tool-image snapshots remain unchanged.
- New HTTP(S) image URLs are fetched once, validated and frozen as data URLs. Fetches have a 15-second deadline, propagate cancellation, and enforce the 5 MiB limit while streaming (not merely via `Content-Length`). Failed snapshots reject admission rather than retaining a mutable fallback URL. Embedded URL credentials are rejected. Display-only images are not fetched or optimized.
- `imageFromBytes`, `imageFromDataUrl`, and default `readImage` remain validation-only. Optimizing the model copy does not change original attachments used for display/delivery.
- The **original** must satisfy the nonempty / **5 MiB** / **25 million pixels** checks and MIME validation. Oversized originals are rejected before optimization even if conversion might make them fit.
- The exact chosen model URL (WebP or original fallback) is persisted in both JSONL and SQLite. Reload, retry, and subsequent requests replay that value without optimizing historical images again. Existing history is not retroactively converted, including history without any preparation marker. A cancelled turn's existing raw-input archival path is preserved without starting image work.
- Transient tool images use the same guard for their one-shot injection; the pre-existing summary-only retention policy is unchanged.
- Raw compatibility API/direct-provider callers have no new-vs-history admission boundary: their supplied history is not silently rewritten. Existing historical HTTP URLs retain their previous provider-specific handling; they are not retroactively snapshotted. This is a session admission guard, not a claim that arbitrary external-client history can be safely recompressed.

Putting a blanket optimizer inside every provider call would change previously sent PNGs and break prompt-cache prefixes. Freezing the result **once on new-message admission** gives centralized coverage without a process-local cache or extra wire fields.

## Channel parity and format coverage

The preparation helper does not branch on channel name: normal new image media admitted from Web, QQ, WeChat, Feishu and Discord uses the same policy. Session-level regression tests cover those five source identities on JSONL and SQLite; this is not live end-to-end delivery certification for each platform. A channel still has to download/classify an attachment as image media. A bare URL in ordinary text is not automatically image media. Existing display-only QQ stickers and access-policy-restricted media do not become model images merely to run compression.

All supported PNG/JPEG/GIF/WebP inputs share validation and freezing; **only eligible PNG is transcoded today**. JPEG, GIF and existing WebP remain unchanged. Unsupported BMP/TIFF/SVG/HEIC/AVIF inputs are not silently decoded or rasterized by this feature. Additional codecs would need their own tests for pixel identity, color/orientation metadata, alpha and multi-frame preservation; JPEG-to-lossless-WebP is not guaranteed to be smaller, and animated GIF must not be silently flattened.

## Conversion policy

Only PNGs of at least **8 KiB** (binary file size, not base64 length) are candidates. Small screenshots can still have substantial lossless savings; the cutoff only avoids codec work on tiny assets. There is no separate optimization pixel cap: eligible images throughout the existing 25-million-pixel input range are attempted. The optimizer skips:

- JPEG, GIF, WebP, and small PNGs;
- high-bit-depth PNGs (only 8-bit PNGs are decoded);
- animated PNGs (`acTL`);
- PNGs with ICC profiles (`iCCP`), EXIF metadata (`eXIf`), chromaticity metadata (`cHRM`), or nonstandard gamma (`gAMA` other than the usual 45455 value). Their metadata is not safely carried into the new WebP;
- malformed chunk layouts.

Encoding uses lossless WebP (`lossless=1`, `near_lossless=100`, `exact=1`) with no resizing or lossy fallback. The result is used only if it is **strictly smaller** than the original, is a valid WebP header, and has the same dimensions. Text/screenshots are not subjected to aggressive JPEG-style quality loss. Transparent pixel colors are preserved by the `exact` setting. Ancillary textual PNG metadata is not copied to the model-input copy; the original remains available.

## Runtime bounds and fallback

- One isolated worker per backend at a time. Concurrent candidates wait in a queue instead of silently using originals due to codec contention. Queued work has not decoded pixel allocations; cancellation while queued returns promptly and prevents that worker from starting. Each active conversion has its own deadline.
- A 10-second deadline terminates the worker and falls back to the original.
- Abort signals terminate active conversion and propagate cancellation rather than substituting an original after cancellation.
- Decode/encode/initialization failures, larger output, and invalid output fall back to the already validated original.
- The worker uses a 128 MiB V8 old-generation limit; the existing input validation caps images at 25 million pixels. Larger images within that range are still attempted and may require substantially more memory. This is **not a hard process/WASM memory cap**: linear memory and external allocations can exceed the V8 heap limit. Worker termination releases its codec memory; conversion does not run on the backend event loop.

## Codec and packaging

Runtime dependencies are pinned to `@jsquash/png@3.1.1` and `@jsquash/webp@1.5.0` (Squoosh-derived WASM codecs), not native image addons. The worker explicitly loads packaged WASM bytes with Node file APIs, avoiding browser `fetch(file://...)` initialization. The portable WebP binary works through the package's JS loader even when its feature detection selects the SIMD-capable loader.

`src/utils/image-codec-worker.js` is a JavaScript build asset: the existing backend asset copier includes it in `dist/src/utils`. Standard production `pnpm deploy` includes the codec packages and their WASM assets. Verification covers compiled backend code in a production deployment outside the source checkout; an Electron installer run is not required to exercise this Node/WASM path.

Focused tests: `pnpm exec node --import tsx --test src/utils/image-optimization_test.ts src/providers/new-message-images_test.ts src/sessions/image-preparation_test.ts src/tools/read-image_test.ts`. Session tests exercise real JSONL and SQLite stores, legacy-history preservation, original snapshots, concurrent/transient tool images, channel archive admission and restart-stable model URLs.
