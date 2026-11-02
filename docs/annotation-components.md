# Annotation components and Agent handoff

## Status

- **Implemented:** image annotation canvas + independent inspector, shared toolbar
  and gestures with preview-dialog marking; overlapping rectangles and open
  strokes; one description per numbered annotation; source-pixel image v1 JSON
  validation/export and attachment metadata integration. No polygon creation UI.
- **Retained compatibility:** existing image v1 polygon geometry, labels and intents
  can still be read and exported. New annotations use the compatible default intent;
  the user no longer has to manage those extra fields.
- **Implemented temporal foundation:** the editor Note lane supports range move/resize,
  inspector descriptions, overlap subrows, and source/sequence time-basis export.
  This is temporal annotation, not spatial video overlay.
- **Proposed below:** generic source-independent Overlay view, host adapters,
  image/video document envelope and video frame/range anchoring. These do not yet
  exist as a working video annotation interface or new backend transport.

## Component boundary

The proposed `AnnotationOverlay` is a view, not an image/file/player service. It
receives geometry, selection, tool and a source-to-viewport transform. It emits
create/update/remove/select events in **source coordinates**. It owns no image URL,
file hashing, media playback, uploads, agent calls, sidebar width or sticky layout.

A host supplies the background and transform: an image preview, a paused video
frame or another bounded raster surface. Letterboxing, zoom, panning and native
orientation must be included in that transform. Pointer hits outside the actual
source bounds are rejected, not attached to the black letterbox. The overlay and
background have a shared content rectangle; a full-screen div over a video element
with different object-fit geometry is not a valid composition.

The proposed controller owns a serializable document. Tool choice, hovered ID,
selection, unfinished pointer points, zoom and inspector expansion are session
state, not document data. One inspector/toolbar may be placed beside or below the
overlay, or hosted separately, using the same controller. A read-only overlay is
useful during playback; an interactive overlay requests a frozen frame before
accepting the first drawing point.

Current `useImageAlignment` is still an image host/controller: decoding, hashing,
legacy Annotorious selection and source lifecycle are not yet generic. Its SVG
input layer is a basis for extraction, not proof this boundary is already complete.

## Source identity and coordinate contract

- Original media must accompany the annotation document, or have a real,
  dispatcher-assigned attachment/file reference accessible to the receiving Agent.
  A hash proves identity, **not access**. Browser blob URLs are never usable source
  references outside that browser and must not be sent as Agent file paths.
- Source revision is the SHA-256 of the actual original bytes. Orientation and
  dimensions are the canonical decoded source coordinate system, independent of
  CSS size. Do not silently resize the source between annotation and handoff.
- Stable annotation IDs identify objects. The numbered badges are display order;
  deleting #2 must not change the remaining IDs or silently rebind instructions.
- Geometry uses explicit `source-pixels`, with dimensions and finite validated
  coordinates. Rectangle = x/y/width/height; stroke = ordered points, open (never
  implicitly a polygon, processing mask or filled region).
- Replacing the source invalidates its old coordinate anchors unless there is an
  explicit, validated conversion. Source revision changes during a gesture cancel
  that unfinished gesture rather than committing to an unrelated frame.

## Video composition

1. Before drawing, pause and freeze the native decoded frame. Lock the source
   revision, intrinsic dimensions and actual presented source time for the gesture.
2. A frame annotation is anchored to that source timestamp. For variable-frame-rate
   media, `frameIndex = time * FPS` is not reliable. Prefer the actual presented
   media timestamp where supported, and record precision/limitations otherwise.
3. A user may explicitly extend it to a source-time interval. That is a fixed
   spatial hint over the interval, **not object tracking** or a moving mask. A
   tracking trajectory would need its own explicit representation and validation.
4. During playback, display applicable annotations read-only. Seeking changes
   which targets are visible; it must not overwrite previously annotated frames.
5. Source time and proposed sequence time are different. A reordered storyboard
   clip has an instance ID and source-in/out mapping. Keep a video annotation's
   source timestamp stable and map to the sequence for display, not vice versa.

Video decoding/playback and clock ownership stay in the host. A source-frame
snapshot may be attached as evidence, with its own hash and timestamp, but is not
silently substituted for the original video.

## Proposed portable payload (not the current runtime schema)

```json
{
  "schema": "shadow.annotation/v1",
  "source": {
    "assetId": "video-1",
    "attachmentRef": "attachment:video-1",
    "sha256": "<64 hex digits of original file>",
    "mediaType": "video",
    "width": 1920,
    "height": 1080
  },
  "annotations": [
    {
      "id": "region-a1",
      "geometry": {
        "type": "rectangle",
        "space": "source-pixels",
        "x": 420,
        "y": 180,
        "width": 320,
        "height": 460
      },
      "temporal": {
        "type": "frame",
        "basis": "source",
        "unit": "seconds",
        "at": 12.4
      },
      "description": "Replace the cup here; preserve the hand and lighting."
    }
  ]
}
```

The attachment reference and SHA above are illustrative. A frame temporal target
may instead be an explicit `{type:"range", basis:"source", unit:"seconds",
start:12.4, end:14.0}`. Images omit the temporal field. Only a dispatcher with an
actual attachment receipt may bind `attachmentRef`; an unbound local draft must
say the source still needs attaching, not claim the Agent can access it.

Keep this proposed envelope separate from the existing image v1 document until
there is a versioned adapter/migration. Do not break working chat attachments by
changing the JSON schema behind the same version number.

## Delivery sequence

1. Freeze a schema-only clone of the document at explicit Apply/Prepare time.
2. Runtime-validate IDs, limits, coordinates, source revision and time bounds.
3. Bind the real source attachment reference and optionally a numbered preview.
4. Send original source + structured JSON + a short human-readable summary into
   the chat draft. Changes after preparing make that snapshot stale.
5. The user submits the draft; an annotation gesture never directly calls Agent.
6. Agent/tool adapter verifies the source hash before interpreting coordinates.
   Descriptions remain quoted user data, not executable configuration or tool code.
   A tool that cannot honor spatial/time targeting reports that limitation; a
   rendered screenshot is not evidence that the actual edit was executed.

## Current concrete handoff

`image-alignment.ts` validates `{version:1, asset:{sha256,width,height}, regions,
description}` and formats it safely. `chat-attachments.ts` preserves that metadata
with the original File through upload and includes it with the returned attachment
path in the message (`composeImageReferenceMessage`). Demo JSON export has no upload
or Agent call; source files still need attaching manually. Non-image timeline
views currently export time-range instructions, not spatial video-frame regions.

Before implementing the proposed video contract, tests must cover letterbox and
zoom transforms, resizing the host, source replacement, seeking during a gesture,
variable timestamps, snapshot staleness, unreadable sources and roundtrip export.
