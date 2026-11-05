# Inline composer references (first version)

`ReferenceComposer.vue` is a contenteditable view over the existing plain-text
composer draft. `ComposerInput` provides the selection/focus/geometry adapter used
by ChatTab, quote insertion, slash completion and session completion. Offsets are
UTF-16 offsets in the serialized draft, including the full hidden reference text.
No message, upload, queue, retry or draft-storage schema changes are involved.

- Session completion's existing Markdown reference renders as an atomic chip with
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

Only the canonical session-reference serialization and references to currently
pending images become chips. Ordinary links/code remain plain text. A stale image
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
