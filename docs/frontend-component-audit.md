# Frontend componentization review

## Scope and method

Snapshot: current `feat/user-alignment` worktree, including the uncommitted
Alignment work. Reviewed `app/src` (the Vue application); this is not a backend,
Electron-main or native-mobile UI audit. Full directory/import inventory covered
177 Vue files and 383 non-test Vue/TypeScript source files. Imports are a static
source count, not runtime instance/coverage measurements. Key candidates below
were then inspected in source. This does **not** claim all 177 components were
mounted, visually reviewed or accessibility-tested.

Conclusion: the app has meaningful domain components and some shared primitives,
but common interaction shells and control styling are still duplicated. A large
number of `.vue` files is not proof of a coherent reusable component system.

## Findings, highest leverage first

### P1 — Confirmation dialogs duplicate both shell and lifecycle

Evidence:
- `components/SessionDeleteDialog.vue`: template at 2; focus/open/close lifecycle
  at 60–70; shell and button styles at 75 onward.
- `components/ProjectDeleteDialog.vue`: template at 2; lifecycle at 55–63;
  near-identical 480 px shell and delete buttons at 68 onward.
- `components/KnowledgeDeleteDialog.vue`: template at 2; lifecycle at 53–60;
  same modal grammar, separate styles at 65 onward.
- `components/KnowledgeRepairDialog.vue`: same opening/focus restoration at
  51–58 and shell styling at 63 onward, with a wider comparison body.
- `components/DesktopBrowserAccess.vue` also defines its own native-dialog shell.

The content and destructive operations differ legitimately; the Teleport/dialog,
heading/body/actions, busy/error appearance, focus-return machinery and sizing
are not all domain-specific. Current focus fallback behavior is not identical:
session deletion deliberately returns focus to a surviving sidebar action when
the trigger is removed. That must survive extraction.

Recommendation: a small native-dialog shell plus a dialog-lifecycle helper,
with explicit initial/fallback focus and close-while-busy policy. Keep deletion
clients, name confirmation and project/conversation/file authorization in hosts.
Do not extract one giant delete-everything business component.

### P1 — New Alignment components still carry cleanup debt

- `StoryboardAlignmentSurface.vue` has no production import in this inventory;
  the active workspace is `EditorAlignmentSurface.vue`.
- `TimelineAlignmentSurface.vue` remains registered in `AlignmentLab.vue`'s view
  map, but `?view=timeline` is redirected to storyboard and no separate timeline
  tab is shown. Thus a second media/range surface remains in source/build despite
  the unified UI. Its file loading and time-range logic overlap with the Editor.
- `SpatialAlignmentSurface.vue` is also unreferenced, but intentionally deferred
  by user scope; do not treat that as authorization to delete its domain support.
- `EditorAlignmentSurface.vue` now composes Tracks/Preview/Zoom, but media pool,
  transport, importing and scenario coordination remain internal. It has six
  `<style>` blocks, including historical rules and later overrides. Zoom and
  Tracks also each have two style blocks. This is cascade debt, not component reuse.
- `AlignmentToolbar.vue` is currently used directly only by the composition demo;
  the real Editor still implements its own toolbar rows. `AlignmentPanel.vue`
  has actual use in both the image wrapper and composition demo.

Recommendation: confirm callers/tests, retire obsolete surfaces and dead styles,
then migrate real toolbar rows to the same primitive. Keep the Editor a scenario
coordinator rather than forcing all playback/import business into visual primitives.
New `AnnotationNoteTrack.vue` is a controlled component hosted by AlignmentTracks;
Tracks has both Editor and composition-demo consumers.

### P2 — Control styling is shared in part, redefined in part

`styles.css` already supplies `.btn`, primary/ghost/small variants and state
behavior; `DESIGN.md` supplies the tokens. Deletion dialogs, several setup views
and the Editor still define local button/input/select shells. The newly added
`alignment-controls.css` introduces another opt-in layer on top of global `.btn`.
That is intentional scoping but still a source of overlapping ownership.

`UiSelect.vue` has 22 direct production importers. Eleven Vue files contain native
`<select>` markup; one is UiSelect's intentional hidden form element, while others
include FolderDialog, BotPackage, QuickActions and Alignment controls. This is
not 11 proven bugs, nor an argument to ban native selects. The equivalent control
states need a documented common styling/behavior contract so switching hosts
does not switch product identity.

Recommendation: converge on existing tokens and a small set of button/field
variants. Only introduce wrappers where they own meaningful behavior or form
semantics. A one-element wrapper around every HTML tag would not solve this.

### P2 — Copy interaction is partly centralized, partly reimplemented

`composables/useTextCopy.ts` already owns async copying, busy/success/error state,
content-change invalidation, timer and unmount cleanup. It is consumed by six
production components: CopyableId, ToolsCard, BotPairingCommand, AgentsTab,
SystemPromptCard and FileTreeContextMenu.

Direct clipboard implementations still exist in DeviceAdministration,
DesktopBrowserAccess, SelectionMenu, ImagePromptDetails and
AlignmentIntentInspector. SelectionMenu has specialized selection behavior;
AlignmentIntentInspector must refuse stale prepared snapshots. These are valid
policy differences, but the low-level async/status lifecycle need not be cloned.

Recommendation: reuse the existing helper where policies match; add clear hooks
for prepared-snapshot validity and custom feedback rather than bypassing those
policies. Do not lose manual-copy fallback on local-network HTTP.

### P2 — Image controls are unified, image-host lifecycle is not yet generic

Actual shared work:
- `ImageDrawingToolbar.vue` has two direct consumers (pixel-marker preview and
  annotation canvas), sharing `image-drawing.ts` straight/freehand semantics.
- Canvas and AnnotationInspector each have two consumers: the compatible
  ImageAlignmentPanel wrapper and the independent composition demo.

Remaining duplication/coupling:
- `files/ImageAnnotationPreview.vue` still owns decoding, limits, pointer capture,
  pan/zoom, global key listeners and bitmap export.
- `alignment/useImageAlignment.ts` independently owns decoding/limits, source
  hashing, pointer capture, scoped key handling and geometric annotation data.
- The current `ImageAlignmentCanvas` still includes an image and a legacy
  Annotorious selection adapter; it is not the proposed universal video overlay.

Recommendation: extract source loading/lifecycle or coordinate-transform utilities
only where contracts truly match, then implement the host-independent Overlay
boundary in `annotation-components.md`. Keep pixel-copy export and semantic
annotation export as separate adapters; merging their outputs would be wrong.

### P3 — Large page coordinators make future duplication easy

Inventory lengths: ChatTab 3,458 lines; SpansTab 1,227; LogsTab 783;
SessionDiagnosis 664. Length alone is not a duplicate-code finding. It indicates
that changes to controls, panels, selection and data routing occur in large
coordinators and need targeted responsibility review. ChatTab should not be
mechanically split by line count or have the agent/session business moved into
new visual components.

## Reuse that already exists and should be preserved

Direct source importers (not runtime instance counts):

| Shared unit | Importers | Concrete value |
| --- | ---: | --- |
| UiSelect | 22 | Form bridge, popup positioning, keyboard and option selection |
| HoverInfo | 11 | Shared tooltip/hover-info behavior |
| ComposerPopover | 6 | Composer control + desktop popup/mobile sheet composition |
| useTextCopy | 6 | Async clipboard state and lifecycle |
| TreeRow | 3 | Folder/session/file-tree row grammar |
| MobileSheet | 3 | Reusable mobile overlay layout and focus handling |
| CopyableId | 3 | Common selectable ID + copy feedback |
| AlignmentTracks / Preview | 2 each | Editor plus composition harness |
| ImageDrawingToolbar | 2 | Shared image control rather than two independent toolbars |

`UiCombobox` has one importer but legitimately differs from UiSelect: editable
filtering versus choosing from existing options. They already share
`selectPopupPosition` from `select-control.ts`. Do not merge them just because
both open a listbox. Similarly, graph/editor/media adapters can share primitives
without sharing their business model.

## Suggested sequence (not executed as part of this audit)

1. Retire unreachable Alignment surfaces/dead overrides after checking routes and
   tests; make actual toolbar rows consume the primitive already introduced.
2. Extract native-dialog shell/lifecycle with session-deletion focus-fallback tests.
3. Consolidate copy status and control variants on the existing helpers/tokens.
4. Extract generic annotation overlay/host transforms with real video-frame tests.
5. Review ChatTab subdomains incrementally; preserve routing/locality/draft contracts.

For each extraction require at least two concrete hosts, a small explicit contract,
container-size/state/keyboard checks and no duplicate outer border/padding. A shared
component must replace old usage, not merely be added next to it. This audit makes
no new claim that all existing custom modal focus behavior is correct or broken;
that requires dedicated runtime verification.
