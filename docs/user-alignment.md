# User Alignment Lab

This experimental workstream treats professional views as **intent-localization
surfaces**, not manual editors. The browser helps users identify an exact target,
state the intended outcome and constraints, and prepare a request. Actual agent
work still belongs to the existing chat session/tool loop.

## Open the lab

From this checkout, with Node 24.15+ and pnpm 12.3.1:

```sh
pnpm install --frozen-lockfile
pnpm --filter @shadow/app exec vite --host 127.0.0.1 --port 5274 --strictPort
```

Open `http://127.0.0.1:5274/alignment-lab.html` on the **same computer**. Loopback
addresses do not route from another computer/phone to this development machine.
Keep Vite on loopback; do not expose its unauthenticated source server on the LAN.

The page has five tabs. A direct link can choose a tab using `?view=timeline`,
`?view=storyboard`, `?view=graph` or `?view=image`.

3D preview is temporarily excluded from this iteration. The old
`?view=spatial` URL falls back to the image view; underlying spatial modules
remain in the repository but are not loaded by this workspace.
Tabs can also be selected with arrow keys, Home and End while focused.

This entry mounts only the lab: no application router, authentication, uploads,
backend requests or agent calls. It is a development entry, not part of the default
production HTML build. Samples are generated locally with no external media fetch.
For a separately built preview (without changing the main app bundle):

```sh
pnpm --filter @shadow/app build:alignment
pnpm --filter @shadow/app exec vite preview --outDir dist-alignment --host 127.0.0.1 --port 5274 --strictPort
```

Use either the dev server or this preview on port 5274, not both. The built entry
retains the same `/alignment-lab.html` path. `dist-alignment` is generated output.

## Implemented views

| View | Real interactions | Anchor and input boundary |
| --- | --- | --- |
| Image | Rectangle drawing/resizing, change/preserve descriptions, overall instructions, draft apply, JSON export; manual before/after candidate comparison | Natural image pixels and SHA-256; existing 20 MiB / 20 MP / 8192 px limits |
| Timeline | Audio waveform, video preview, playback, time ruler, zoom, drag selection, range resize/move, numeric range controls, audio/video/subtitle/shot intent categories | Source seconds and file SHA-256; local browser-supported media up to 40 MiB and 20 minutes; video uses a neutral lane, not an invented audio waveform |
| Storyboard / assets | Linear proportional clip track with thumbnails, ripple edge resize, pointer/keyboard reorder, scrubbed static image preview, source asset bin | Stable item IDs, explicit proposed order and contiguous shot start/end/duration anchors; up to 24 PNG/JPEG/WebP images, each under 20 MiB |
| Graph | Node/edge selection, pan/zoom, node layout, connection proposals, keyboard-friendly element selection and endpoint controls; local graph JSON input | Node/edge IDs and proposed connections, not executable workflow edits; up to 100 nodes and 200 edges |

The timeline starts with a deterministic 12-second WAV; the storyboard starts
with four illustrated shots.
The graph starts with a creative-brief/script/references/shots/review workflow.

Graph JSON input has this shape; positions are optional display state:

```json
{
  "nodes": [
    { "id": "brief", "label": "Creative brief", "position": { "x": 0, "y": 100 } },
    { "id": "review", "label": "Review" }
  ],
  "edges": [{ "id": "brief-review", "source": "brief", "target": "review" }]
}
```

Import is a bounded JSON adapter, not native Unreal/ComfyUI workflow compatibility.
Local GLB validation rejects URIs (including data URIs), extensions and alternate
resource locations; accepted textures must be PNG/JPEG stored in the BIN chunk.
This deliberately excludes many compressed/extension-based production models.
Unsupported media, invalid UTF-8 and invalid GLB/graph input fail explicitly.

## Shared alignment flow

Timeline, storyboard and graph share `AlignmentIntentInspector.vue`:

1. Select a target in a view.
2. Choose **Requested change**, **Keep unchanged** or **Use as reference**.
3. Describe the target-specific outcome and/or the overall change.
4. Specify constraints and invariants separately.
5. **Prepare request**, then **Copy request** or **Export JSON**.
6. Paste into a real chat and attach any referenced source files when ready.

Reordering shots and proposing an edge are themselves explicit intents; their
initial description is filled from that gesture and remains editable. Source
files and actual workflows are never changed by these proposals. Removing a
connection proposal removes its dashed edge; removing an order proposal restores
the original arrangement. Reference/preserve classifications do not implement
processing masks or guarantees.

Prepared text is invalidated when its draft changes, so a stale request cannot be
copied as though it reflected the current selections. Descriptions persist while
switching tabs. Changing sources asks before dropping targets or overall
instructions. Hidden media stops playing; hidden graph views release their
rendered viewport while the application retains the semantic targets.

Everything is in browser-tab memory. Export before refreshing; there is no durable
annotation store or JSON re-import workflow yet. Exported requests identify source
revisions but do **not** attach local media automatically. They explicitly ask the
agent to request inaccessible source files instead of pretending to process them.

## Existing image-to-chat integration

When running this branch's full application UI against an appropriate development
backend (see [development isolation](development.md)), add/paste a local image,
open its attachment preview, then select **Region instructions**.

Applying image instructions updates that pending attachment; it does not upload or
send. Normal Send uploads the unchanged input image and serializes its alignment
request with the returned attachment path into ordinary user message content. The
same composition function is used for attachment replies to input questions. The
browser does not create a second agent loop or bypass permission checks.

**Freehand marks** remains separate: it exports a marked copy. Region instructions
use the file loaded by the dialog without burning boxes into the input pixels.
Changing the File clears previous region metadata. Reopening a pending image
restores applied instructions. Unapplied changes prompt before a normal modal
close, while switching conversation/removing the attachment tears the editor down.
Already-sent media and file-workbench previews do not yet expose this structured
editor. None of the other five views has automatic chat attachment integration yet.

## Code and dependencies

- `app/src/components/alignment/AlignmentLab.vue`: tab host and independent drafts.
- `AlignmentIntentInspector.vue`: shared description/constraint/request UI.
- `*AlignmentSurface.vue`: time, sequence, relationship and 3D adapters.
- `ImageAlignmentPanel.vue` / `ImageAlignmentLab.vue`: original image adapter and lab.
- `app/src/alignment-lab-model.ts`: validated `shadow.alignment/v1` schema and request formatter.
- `app/src/alignment-{timeline,storyboard,graph,spatial}.ts`: pure domain helpers.
- `app/src/image-alignment.ts`: existing `version: 1` image protocol. It is preserved
  rather than silently migrated; cross-modality unification is still experimental.
- `app/src/chat-attachments.ts`: unchanged normal transport path plus image metadata.

New dependencies are pinned: Annotorious 3.9.5 (BSD-3-Clause), wavesurfer.js 8.0.3
(BSD-3-Clause), vue-draggable-plus 0.6.1 (MIT), and model-viewer 4.4.0 (Apache-2.0).
Graph reuses Vue Flow 1.41.5 already in the application. Direct-library notices are
in `app/public/licenses/`.

For images, the adapter reads the live annotation store at apply/export/close:
upstream geometry notifications can lag by one second. It reads rectangle x/y/w/h
rather than cached bounds, which can lag a resize in Annotorious 3.9.5. Only
axis-aligned rectangles are exposed; the unsupported rotation handle is hidden.

Graph/sequence context is an immutable source snapshot; proposed shot timing is
exported separately in sequence selectors. Graph display positions are not
execution instructions.

## Verification

```sh
pnpm --filter @shadow/app typecheck
pnpm exec node --import tsx --test app/src/alignment-lab-model_test.ts app/src/alignment-timeline_test.ts app/src/alignment-spatial_test.ts app/src/alignment-lab-rendered_test.ts
pnpm exec node --import tsx --test app/src/image-alignment_test.ts app/src/chat-attachments_test.ts app/src/image-context_test.ts app/src/chat-session-live_test.ts app/src/i18n_test.ts scripts/pnpm-environment-lock_test.ts
pnpm exec node --import tsx --test app/src/image-alignment-rendered_test.ts app/src/image-annotation-rendered_test.ts
pnpm --filter @shadow/app build
pnpm --filter @shadow/app build:alignment
```

Rendered tests use isolated Electron user-data directories and synthetic files.
They check native waveform range drawing, real WAV decoding/playback and hidden
pause, storyboard order proposals, graph node selection and connection proposals,
a genuinely rendered GLB and
surface pick, export data, tab restoration, narrow viewport overflow, and the
absence of backend/external-media requests. Numeric and parser tests cover invalid
ranges/IDs, source mismatch, Unicode, GLB offline validation and bounded inputs.
Image tests cover native drawing/resizing, original bytes, explicit apply,
reopening, read-only controls and the ordinary mocked chat send path. The chat
fixture isolates unrelated bot-review polling from this focused test environment.

## Not claimed

- No live AI editing/generation quality acceptance, protection-mask fidelity or
  automatic output-to-intent matching. Image candidate comparison is manually loaded.
- No workflow runtime, timeline render engine, pixel editor, mesh editor or CAD.
- No native professional project-format compatibility beyond the stated inputs.
- No durable drafts, cross-version anchor migration, collaboration, source upload
  from the lab or automatic acceptance/rejection transactions.
- No unrestricted GLB extension/texture support, full mobile-touch certification,
  large-asset benchmarks or complete keyboard-only image/3D region creation.
- Video codec/metadata availability is browser-dependent; neutral video timeline
  support is distinct from audio waveform analysis and frame-accurate editing.

### Storyboard shot timeline

The storyboard is a linear clip track, distinct from the independent audio/video
range view. Clip positions and widths use seconds × pixels-per-second (16–120 px/s
zoom), with no minimum clip width or flex distortion. Scroll horizontally on narrow
screens. Drag a clip to reorder it; drag its left or right edge to decrease/increase
its duration with continuous ripple placement (no gaps). Left-edge resizing changes
duration, not an image's source in-point. Select a clip to open its inspector directly.
Arrow Left/Right on focused clip buttons and the earlier/later buttons reorder;
the selected clip's numeric duration input is the keyboard alternative to edge dragging.
Finite durations are limited to 0.1–600 seconds. Local images start at 3 seconds.

The ruler supports pointer scrubbing; the labeled Playhead range provides a keyboard
alternative. Preview is explicitly **static**, selecting the image under the playhead
(no automatic playback, rendering, frame extraction, or media trimming).
The source asset bin is for adding clips, not primary arrangement. Repeated additions
create unique instance IDs while exported `shots[].sourceId` points back to the immutable
asset ID in `source.context` (with local filenames and SHA-256 where available).

Sequence annotations export contiguous `shots` (instance ID, sourceId, start, end,
duration), selected instance IDs and proposed order. Legacy exports without sourceId
remain valid. Times are **proposed sequence seconds**, not source-media timestamps.
Descriptions and intents survive timing/reorder changes. Removing a clip removes its
empty anchors (or prunes it from group anchors). Removing the order/timing proposal
restores source order/durations, removes added instances, and refreshes/prunes anchors.
At least one clip remains; the experimental bin permits at most 100 total instances.
Source replacement confirms before discarding annotations or global instructions.
Drafts are tab-local and are not restored after browser refresh; export before leaving.
No external upload or AI call occurs. The separate audio/video timeline remains for
source-time range instructions. There is no text-specific alignment view or text-range
selector; shared description fields remain ordinary text inputs.

### Image library and prompt notes

The image surface opens with a natural-aspect-ratio masonry overview. Select a card
for its prompt sidebar, or open image details for a large preview. The same editable
keyword tags and complete prompt stay visible on the right in both desktop modes;
on narrow screens they move below the images. Batch import supports PNG/JPEG/WebP.
Six geometric demo images of varied proportions are synthesized locally; their
prompts are explicitly illustrative, not recovered generation metadata.

Imported images start with an unknown/empty prompt and keywords. Enter notes manually;
there is no upload, AI inference, metadata extraction or image generation. Copy or
export the selected image's prompt/keywords as JSON (including filename and provenance).
Applied region instructions and manually loaded comparison candidates remain separate
from prompt notes. Visited region editors stay mounted per image so switching images
or returning to overview retains even unapplied drafts without silently discarding them.
All library state is page-local, not persisted across refresh; prompt JSON exports do
not include image bytes or unapplied region drafts. Source/candidate object URLs are
released when the surface closes. The ordinary chat image viewer is not changed by
this experimental library layout.

## Unified Edit workspace

The former Timeline and Storyboard tabs now share one Edit workspace. Both legacy
`?view=timeline` and `?view=storyboard` open it. Reference consulted:
https://www.blackmagicdesign.com/products/davinciresolve/edit (official Edit page).
Borrowed structure: left media pool, central program viewer, right inspector,
lower sequence with track headers, a shared ruler and playhead. No brand assets copied.

Scene selector provides four static illustrated storyboard shots, a clearly labelled
simulated video animatic, and real locally synthesized 12-second PCM audio with a
PCM-derived waveform. Video is not decoded playback. Storyboard/animatic clip order and duration changes are proposals. Audio and imported
video use an immutable source timeline with range annotation only, so the shared
playhead, waveform and preview cannot drift from a proposed arrangement. Scene replacement
requires confirmation when instructions exist. Image collections and local audio/video files (up to 40 MB / 20 minutes) may be
imported into the same workspace. Native media playback uses source seconds;
imported audio is decoded locally for its waveform. Unsupported codecs are rejected. No media or
instructions are uploaded. Overall and anchored intent, source revision and JSON
request export continue through the shared inspector. Drafts are tab-local.


The editor labels use the existing English/Simplified Chinese locale dictionaries.
The inspector shows readable shot/time summaries; raw selector coordinates are
available under collapsed details. Audio media-pool thumbnails come from actual PCM
peaks; there are no unrelated picture clips in the audio workspace.

### Direct image annotations

Opening an image uses one main annotation canvas. Freehand is ready immediately;
Shift-drag creates a straight line. Rectangle creates continuous, overlapping
numbered boxes. There is no separate Add-region activation or polygon creation
tool. Each right-hand card contains its number and **one description field**;
there are no separate label or intent controls. The internal v1 intent defaults
to change for new annotations only; legacy labels/intents/polygon geometry remain
readable and serializable without silently changing old documents. Delete is
available per card. Whole-image Prompt keywords remain a separate component.

Draft annotations survive image and overview switches while the page is open.
Closing/reloading the page loses local drafts. Export instructions serializes the
source SHA-256 and natural image dimensions; coordinates and polygon/stroke
points are original-image pixels. A `stroke` is explicitly an open line, never a
closed area or mask. Rectangle-only v1 documents remain supported in chat
attachments. No annotation burns pixels into the original or invokes an AI.

### Alignment control styling

The editor zoom control displays actual timeline pixels per source second
(`px/s`), not a percentage. Minus/plus buttons adjust by 4 px/s between 16 and
120 px/s; the native slider also supports arrow keys, Home and End. Buttons at
limits and controls while loading are disabled. The standalone media timeline
uses the same control with its own 10–200 px/s range and 2 px/s step. Focus rings
remain visible on keyboard navigation; the thin visual track retains a 30 px
input hit area. These controls and the toolbar/inspector styles are scoped to
Alignment Lab rather than the application chat UI.

## Composable UI — first iteration

Open `alignment-lab.html?view=components` (also linked from the lab header).
This is a live composition harness, not a second application: change the host
between side-by-side, stacked and 320 px layouts without remounting its content.
The two prompt editors marked by their position share a single controlled image;
the independent editor has its own state. The timeline below has its own state.
3D preview is excluded from both the lab and this harness for this iteration.

### Ownership and contracts

| Component | State / interface | Host responsibility |
| --- | --- | --- |
| `AlignmentPanel` | Optional `title`, default and `actions` slots; owns one border and 16 px internal padding | Placement, width, external gap; do not wrap a panel in another panel for decoration |
| `AlignmentToolbar` | Default slot, optional accessible `label`; wrapping flow, no outer padding | Group label, ordering, placement and disabled state of controls |
| `ImageAlignmentCanvas` | `controller`, `file`, `editable`, `active`; original-image coordinates | Supply one mounted canvas per controller; give the image room; no fixed sidebar |
| `ImageAnnotationInspector` | Same controller as canvas, `editable`; selection and descriptions stay synchronized | May be beside or below the canvas; no canvas ancestor required |
| `useImageAlignment` | Reactive file/initial/editable/active props, `apply`/`clear` callbacks; refs and actions | Lifecycle must be a Vue setup scope. Source is fixed per mounted controller: remount with a source key when replacing. Set active false when hidden. Preserve controller to retain drafts |
| `ImageAlignmentPanel` | Existing file/initial/editable/active props and apply/clear events, details slot, exposed flush/hasUnsavedChanges | Backward-compatible canvas + inspector composition for chat and image library; container query stacks below 680 px |
| `ImagePromptDetails` | `image`, `controlled`, `update({prompt?,keywords?})` | With controlled=true apply patches to host state. Legacy default mutates the supplied reactive image for compatibility. No source parsing or inference |
| `AlignmentPreview` | Media through default slot, optional animating flag; natural 16:9 size | Host can override size via its own class, e.g. the editor's constrained preview. No viewport height or sticky positioning |
| `AlignmentZoom` | v-model number, min/max/step/disabled; native range and px/s output | Same scale value must be passed to tracks; numeric bounds must be finite and max > min |
| `AlignmentTracks` | items/timing/chosen/targets/samples/totalDuration/scale/playhead/source mode; emits choose, move, pointer, select, track element and selectedTrack updates | Own selection and playhead, implement seek/reorder/resize from pointer events. Timing must correspond to items. Tracks renders geometry; it does not play media or silently modify a proposal |

Content components own **no external margin, fixed sidebar width or sticky
placement**. A host grid chooses the layout. Panel surfaces establish container
scope; content uses natural wrapping and local queries, not a required
`.alignment-workbench .image-detail` ancestor. Use a practical 280–320 px width
for text inspectors. Narrower widths can wrap but are not a supported efficient
editing layout. Track content scrolls internally. Overall layouts below the
combined minimum must stack. The first release is not a promise that every
arbitrary pixel width is usable.

The full Editor remains a scenario coordinator: source import, native media
clock, proposal editing and source-replacement confirmation are **not** moved into
a universal store. Its track/preview/zoom views are reusable; its media pool and
transport are still internal. Graph remains an adapter to Vue Flow with opt-in
shared controls. These are explicit remaining boundaries, not fully decomposed
headless engines.

`alignment-controls.css` is opt-in to component roots (`alignment-content`,
`alignment-surface`, `alignment-toolbar`) and existing lab hosts. It provides
Quiet Workbench square controls and semantic CSS variables; no global chat rule
is changed. Only the host chooses a theme, and source/selection/error colors
retain their meaning. No fonts or dependencies are added.

Verification: `app/src/alignment-composition-rendered_test.ts` mounts without
an Alignment page ancestor and exercises shared/isolated state, long text,
same-viewport 320 px/stacked/wide hosts, retained annotation draft, border
ownership, zoom-to-track synchronization, keyboard ordering and mobile overflow.
Existing image drawing and editor tests retain pointer/media coverage.

### Local-network HTTP compatibility

Source fingerprinting uses native SHA-256 when SubtleCrypto is present, and a
byte-compatible SHA-256 fallback for non-secure local-network HTTP origins.
IDs use the existing getRandomValues-based UUID fallback, never Math.random.
The canvas renders a visible retry/error state if initialization fails rather
than an unexplained white area. Clipboard APIs may still require HTTPS; JSON
export remains available. This does not relax browser security policies.

### Interaction feedback

Opt-in component controls share 140 ms background/border/ink transitions, with
separate hover, pressed, persistent selection, focus and disabled treatments.
Image cards, annotation strokes, clip borders and resize edges have local feedback;
static panels do not pretend to be clickable. Slider thumb feedback is animated,
but slider position, drawing points, clip geometry and playhead remain immediate.
`prefers-reduced-motion` removes these transitions without removing state cues.
The composition browser regression inspects hover/active via Chromium CSS states,
clicks persistent selection, and emulates reduced motion to verify transitions stop.

### Unified image drawing controls

`files/ImageDrawingToolbar.vue` is shared by the preview dialog's pixel-marker
adapter and the annotation canvas. `image-drawing.ts` owns their common gesture
semantics: freehand by default, Shift at pointer-down temporarily selects a
straight line, and the explicit line tool always stores two endpoints. Opening
an editable image or returning to it immediately arms the current tool; no
"Add region" activation is required. The Rectangle tool also remains
armed after a completed shape. Select/inspect stops drawing and lets existing
objects be selected and resized. Choosing an inspector row only changes the
selected annotation; it no longer disarms the drawing tool. Escape cancels an
unfinished gesture while keeping the tool ready; it does not delete finished work.

The toolbar accepts v-model tool, supported tools, disabled/canUndo props,
undo event, and optional colors/actions slots. Capability differs from output:
the existing pixel-mark adapter retains its palette, flattened PNG attachment,
Ctrl-drag references, pan/zoom and automatic marked-copy update. Region mode and
the lab use the same drawing control with the extra Rectangle choice,
original-coordinate annotations and explicit apply/export. Opening, drawing or
changing tools in region mode never sends a message or silently replaces the
source bytes. Both adapters share the toolbar and gesture helpers, not separate
implementations of Shift-line behavior.


### Numbered, overlapping image annotations

Rectangle creation and freehand input now share one source-coordinate
pointer surface. This avoids competition between the library editor's hit tests
and the drawing overlay, including drags starting inside an existing box.
Annotorious is retained for Select-mode rectangle resizing and source-store
reconciliation, not as a second competing creation gesture engine.

Each annotation has a numbered badge and an independent inspector card with
coordinates, a single description and delete action. Cards show every annotation's
summary; only the selected card expands its editor. Repeated corner coordinates
and overlapping/nested boxes are permitted. Nearby badges are offset so both
numbers remain visible. Numbers reflect current list order; stable exported IDs
identify regions across edits and deletion. In drawing mode badges don't intercept
drag starts. In Select mode badges/frames can select the corresponding card.
Clicking a card never silently changes the tool. A stationary freehand click now
creates a visible dot. Creation remains active until the user explicitly selects
Select/inspect; this is distinct from selecting an annotation's description.


### Overlay composition and Agent handoff design

See [Annotation component and Agent handoff boundaries](annotation-components.md)
for the proposed host/overlay/document separation and video temporal anchoring.
That proposal is not an implemented video-overlay feature. Current image v1
serialization and chat-draft binding remain unchanged.

### Note track

The unified editor now has an N1 Note lane. `Add Note` creates a range beginning
at the playhead (two seconds by default, bounded by the current duration). Each
Note uses a stable existing `time-range` target ID and the same description in
the inspector. Notes render at `start * scale`, width `(end - start) * scale`;
overlapping notes occupy separate subrows. Non-temporal sequence proposals stay
in the inspector instead of pretending to have a Note duration.

Drag the body to move a Note without changing its span; drag either edge to
change start/end. Arrow keys move the focused body/edge by 0.1 s, Shift+Arrow by
1 s; numeric In/Out and Note duration are alternatives. Editing pauses playback.
Pointer cancel, Escape, hiding the view, source-duration or zoom changes cancel
an unfinished drag. Source bounds and a positive minimum span are enforced.
A commit updates the existing target, preserving its description and ID; it does
not append a second instruction. Removing the instruction removes the Note.

Export includes `start`, `end`, `duration` (the **total source/sequence duration**,
for v1 compatibility), `trackId` and explicit `timeBasis: source | sequence`.
The Note's own duration is **end - start**, not the legacy selector.duration.
Real imported media and generated audio use source seconds; simulated animatic
and storyboard use proposed sequence seconds. Sequence-duration changes clamp
sequence-time Note ranges to the remaining sequence extent without changing IDs.
Reordering clips does not imply object tracking or source-time remapping.

`AnnotationNoteTrack.vue` is controlled and source-independent: notes/duration/
scale/selectedId/disabled in, select/change events out. It owns only a transient
drag preview. `annotation-notes.ts` contains bounds and overlap layout logic.
Both Editor and the component composition harness host it through AlignmentTracks.
Spatial video-frame overlay is still a separate pending feature; the Note lane
currently carries time-bound descriptions, not tracked masks or rendered edits.
