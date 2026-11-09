# Inline composer references (first version)

`ReferenceComposer.vue` is a contenteditable view over the existing plain-text
composer draft. `ComposerInput` provides the selection/focus/geometry adapter used
by ChatTab, quote insertion, slash completion and session completion. Offsets are
UTF-16 offsets in the serialized draft, including the full hidden reference text.
No message, upload, queue, retry or draft-storage schema changes are involved.

- Work and Session references use canonical Markdown links parsed by
  `content-references.ts`. Work's Discuss actions insert the existing dashboard
  route with its `work` query; Session completion retains the existing chat route
  and virtual-path context hint. Both render as atomic chips. Session completion's
  reference retains
  its escaped title decoded as text (never HTML). The source link uses ChatTab's
  existing same-project conversation navigation; modified clicks retain link behavior.
- The attachment toolbar's **Insert image reference** action renders an image chip
  for the exact stable reference of a pending image attachment. Preview opens the
  existing image preview/editor, including marked copies. Same-named files retain
  distinct keys. Removing a chip removes its inline text, not the attachment;
  removing an attachment continues to use ChatTab's existing cleanup.
- Chip removal, adjacent Backspace/Delete, copy/cut, plain-text paste, selection
  replacement, multiline editing and composition all use the original draft text.
  HTML clipboard content is not inserted into the editor. Image/file paste stays
  owned by ChatTab (its capture listener can reject a paste before editing).
- Enter/queue shortcuts remain owned by ChatTab. Keyboard actions on chip controls
  do not submit the message. Chip controls have keyboard-accessible HoverInfo hints.

## Deliberate limits

Only canonical Work/Session app links and references to currently pending images
become chips. Ordinary links and fenced/inline code containing app links remain
plain text. Reference routes are not filesystem launch URLs. ChatTab's shared
link handler routes Work links to the existing dashboard and retains Session's
existing conversation selection behavior. Modified clicks retain anchor behavior.
There is no canonical message-permalink route in this implementation; message
references are not synthesized. A stale image
reference without its attachment remains readable protocol text: attachments are
not rehydrated from localStorage and this UI does not invent an upload or source.
Images are compact labelled chips with a preview action, not inline full-size
photos. The original attachment strip remains available for file management.

Undo/redo is local to the mounted conversation composer and retains the most
recent 100 editing snapshots; this is not a general rich-text editor, HTML editor,
or cross-device editing history. Drag-reordering chips is not implemented.
Synthetic composition and Chromium editing are tested; real mobile keyboards,
platform IMEs, assistive-technology announcement and native desktop clipboard
integration still require hands-on coverage.

## Focused checks

- `pnpm exec node --import tsx --test app/src/composer-references_test.ts app/src/composer-references-rendered_test.ts`
- `pnpm --dir app exec vue-tsc --noEmit`
- `pnpm build:app`

The rendered test launches isolated Electron/Vite fixtures with disposable profiles,
checks caret/text mapping, protocol copy, native typing, undo, newline/paste, IME,
chip deletion/preview, submit-key routing and desktop/mobile-width overflow. It does
not start the user's backend or read runtime data.

Existing renderer smoke fixtures now target `.reference-composer` rather than a
textarea. `desktop/tests/fixtures/composer-test-adapter.ts` is test-only glue for
legacy fixture actions: it projects value/caret/disabled properties from real DOM
text, reference spans, browser Selection and ARIA state before evaluation. It does
not patch Vue state or ship to the app. Dedicated answer/discussion textareas and
synthetic non-ChatTab textarea fixtures remain unchanged. The original
`composer-rendered_test.ts` uses the real editor and retains its queue, custom
question, attachment-failure recovery and mobile assertions.

## Future attachment text

New Web sends append an escaped `<attachment-references version="1">` block
instead of the old Attachment references / Uploaded file / Media item prose.
`src/utils/attachment-references.ts` defines this deliberately small text format;
`composeImageReferenceMessage` supplies image and file names, exact uploaded paths,
stable image-reference tokens, one-based media order and optional original/marked
source metadata. XML escaping includes quotes, angle brackets and newlines.
The user's draft and model input remain text. This is not a storage AST.

The block is display metadata, not media authorization. The backend still admits
only the separately supplied `media` array through its existing image/file
pipeline (`src/agent/message-builder.ts`); it never reads paths found in XML.
History images remain the admitted image parts and non-image history retains the
existing `[file: ...]` annotation. No backend/storage conversion is necessary.
`messageAttachments` shields XML-looking blocks from legacy MEDIA/file-marker
parsing and removes a canonical block only when existing media supports its
attachment count/kinds and file paths. It never adds an XML path to previews.
The existing MessageAttachments component renders admitted images/files, retaining
its session-aware asset resolution, file preview and authorized download behavior.
Missing, malformed or unsupported metadata stays text; code examples stay code.
Repeated identical history image data can share the existing deduplicated preview.

Old prose, MEDIA markers and file annotations keep their existing compatibility.
No stored history is rewritten. Retry already resends the original text/media
without appending another reference block. New references are not reconstructed
from stale drafts. This change is scoped to the Web composer, not a rewrite of
external channel attachment protocols.

Additional focused checks: `content-references_test.ts`, `chat-attachments_test.ts`,
`message-attachments_test.ts`, `project-coordination_test.ts`, the rendered
conversation-file-link fixture, and `src/agent/message-builder_test.ts`.

### Rendered producer-to-preview integration

`pnpm exec node --import tsx --test app/src/content-references-rendered_test.ts`
launches an isolated Electron/Vite fixture with synthetic files and a disposable
profile. It calls the actual Web attachment producer, renders its output with
`messageAttachments`, `MarkdownContent` and `MessageAttachments`, and opens the
real ImageViewer and FilePreviewModal. A second row uses real backend-built
history parts (encoded image plus file annotation), projected using ChatTab's
actual history helpers. Both rows must hide the XML metadata while retaining
working image and file previews.

The fixture executes ChatTab's extracted Markdown renderer/sanitizer and link
handler unchanged against real DOM anchors and a Vue memory router. Work and
Session clicks must reach their existing route shapes and update a destination
readout. This verifies route dispatch, not the full dashboard/session data load.
Fenced XML remains visible code; forged XML and hostile escaped attributes must
create no attachment, outbound fetch, raw file navigation or script execution.
All media API requests are checked against the two admitted synthetic paths.

Only the unused rich-file SDK leaf is replaced with a throwing test module, so
PDF/Office infrastructure is neither loaded nor claimed covered. The actual
image, Markdown, file-modal and attachment components and their resource/fetch
code are not mocked. No production backend or profile is used.
