---
name: "Shadow — Quiet Workbench"
description: "A quiet, square-edged workbench with neutral reading surfaces and purposeful state color."
colors:
  light-bg: "#f3f3f3"
  light-bg-soft: "#f7f7f7"
  light-bg-card: "#ffffff"
  light-bg-muted: "#ededed"
  light-bg-input: "#ffffff"
  light-bg-code: "#202020"
  light-bg-code-inline: "#ededed"
  light-border: "#dedede"
  light-border-hover: "#a3a3a3"
  light-border-soft: "#e7e7e7"
  light-control-border: "#858585"
  light-scrollbar-thumb: "#858585"
  light-scrollbar-thumb-hover: "#626262"
  light-text: "#242424"
  light-text-body: "#404040"
  light-text-secondary: "#525252"
  light-text-muted: "#626262"
  light-text-faint: "#686868"
  light-text-on-dark: "#e7e7e7"
  light-text-on-primary: "#ffffff"
  light-primary: "#245bc1"
  light-primary-hover: "#1e4c9f"
  light-primary-bg: "#245bc1"
  light-primary-bg-hover: "#1e4c9f"
  light-blue: "#245bc1"
  light-selection-bg: "#eaf1ff"
  light-selection-border: "#a8bfeb"
  light-success: "#267047"
  light-success-bg: "#edf6ef"
  light-error: "#b33e3e"
  light-error-bg: "#fbeeee"
  light-warn: "#895b16"
  light-warn-bg: "#faf1dd"
  light-info: "#245bc1"
  light-info-bg: "#eaf1ff"
  light-amber: "#895b16"
  light-grid-dot: "#dcdcdc"
  light-shadow: "rgba(0, 0, 0, 0.14)"
  light-shadow-soft: "rgba(0, 0, 0, 0.06)"
  light-shadow-softer: "rgba(0, 0, 0, 0.05)"
  light-frosted: "rgba(255, 255, 255, 0.7)"
  light-git-added: "#1a7f37"
  light-git-modified: "#8a6500"
  light-git-deleted: "#c72e39"
  light-git-renamed: "#0969da"
  light-diff-added: "#15803d"
  dark-bg: "#141414"
  dark-bg-soft: "#1a1a1a"
  dark-bg-card: "#202020"
  dark-bg-muted: "#292929"
  dark-bg-input: "#202020"
  dark-bg-code: "#141414"
  dark-bg-code-inline: "#292929"
  dark-border: "#353535"
  dark-border-hover: "#626262"
  dark-border-soft: "#2b2b2b"
  dark-control-border: "#808080"
  dark-scrollbar-thumb: "#808080"
  dark-scrollbar-thumb-hover: "#a0a0a0"
  dark-text: "#e7e7e7"
  dark-text-body: "#d4d4d4"
  dark-text-secondary: "#b3b3b3"
  dark-text-muted: "#a0a0a0"
  dark-text-faint: "#969696"
  dark-text-on-dark: "#e7e7e7"
  dark-text-on-primary: "#ffffff"
  dark-primary: "#8bb7ff"
  dark-primary-hover: "#b5d0ff"
  dark-primary-bg: "#315fa8"
  dark-primary-bg-hover: "#396cbb"
  dark-blue: "#8bb7ff"
  dark-selection-bg: "#25334a"
  dark-selection-border: "#456391"
  dark-success: "#8dcca3"
  dark-success-bg: "#21362a"
  dark-error: "#ef9b9b"
  dark-error-bg: "#402729"
  dark-warn: "#e4ba70"
  dark-warn-bg: "#382d1c"
  dark-info: "#8bb7ff"
  dark-info-bg: "#25334a"
  dark-amber: "#e4ba70"
  dark-grid-dot: "#252525"
  dark-shadow: "rgba(0, 0, 0, 0.4)"
  dark-shadow-soft: "rgba(0, 0, 0, 0.2)"
  dark-shadow-softer: "rgba(0, 0, 0, 0.15)"
  dark-frosted: "rgba(20, 20, 20, 0.7)"
  dark-git-added: "#73c991"
  dark-git-modified: "#d9b778"
  dark-git-deleted: "#f48771"
  dark-git-renamed: "#75beff"
  dark-diff-added: "#4ade80"
typography:
  draft-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(19px, 2vw, 26px)"
    fontWeight: 500
    letterSpacing: "-.025em"
  project-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  navigation:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "20px"
  button:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  conversation:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.8rem"
    lineHeight: 1.5
  composer:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.6
  mobile-input:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.5
  mobile-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  offline-title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.6
  activity:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    lineHeight: 1.5
  tool-payload:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "12px"
    lineHeight: 1.6
rounded:
  sm: "0px"
  control: "0px"
  surface: "0px"
  overlay: "0px"
  pill: "0px"
  circle: "0px"
spacing:
  sidebar-row-height: "32px"
  sidebar-project-height: "36px"
  sidebar-gutter: "8px"
  sidebar-row-inset: "4px"
  sidebar-indent: "16px"
  sidebar-disclosure: "20px"
  sidebar-icon-gap: "8px"
  sidebar-heading-gap: "4px"
  sidebar-group-gap: "12px"
  sidebar-section-gap: "16px"
  sidebar-action-size: "28px"
components:
  button-primary:
    backgroundColor: "{colors.light-primary-bg}"
    textColor: "{colors.light-text-on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-primary-hover:
    backgroundColor: "{colors.light-primary-bg-hover}"
  button-primary-dark:
    backgroundColor: "{colors.dark-primary-bg}"
    textColor: "{colors.dark-text-on-primary}"
  button-primary-dark-hover:
    backgroundColor: "{colors.dark-primary-bg-hover}"
  button-secondary:
    backgroundColor: "{colors.light-bg-card}"
    textColor: "{colors.light-text}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-ghost:
    backgroundColor: "transparent"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  composer:
    typography: "{typography.composer}"
    rounded: "{rounded.overlay}"
    padding: "12px 12px 9px"
  mobile-header:
    backgroundColor: "{colors.light-bg-card}"
    typography: "{typography.mobile-title}"
    rounded: "{rounded.control}"
  navigation-selected:
    backgroundColor: "transparent"
    textColor: "{colors.light-primary}"
    typography: "{typography.navigation}"
    rounded: "{rounded.control}"
  context-chip:
    rounded: "{rounded.control}"
    padding: "4px 5px 4px 8px"
  conversation-card:
    typography: "{typography.conversation}"
    rounded: "{rounded.surface}"
    padding: "0.5rem 0.75rem"
  message-action:
    rounded: "{rounded.surface}"
    padding: "12px"
  session-activity:
    typography: "{typography.activity}"
---

# Design System: Shadow

## Overview

**Creative North Star: "Quiet Workbench / 安静的工作台"**

Keep the existing workbench layout and square-edged controls. Paper in light mode and graphite in dark mode create a restrained, neutral setting for reading conversations, inspecting work, and choosing the next action. Hierarchy comes from spacing, clear text, and small changes in surface tone, not a collection of colored panels.

Color has a job: blue identifies interaction, selection, and information needing attention; green communicates success, connection, or completion; amber requests human attention or warns; red identifies failure or destructive action. Routine thinking, tool execution, idle state, trace information, and peer origin remain neutral. Controls are precise and restrained rather than ornamental.

**Key Characteristics:**
- Neutral reading surfaces with clear, grayscale text.
- Square corners and compact, grouped navigation.
- Flat conversation cards; structural shadows for overlays.
- Semantic color for meaningful state, not sender identity.

This is normative guidance for the unified workbench palette, grounded in `app/src/styles.css`, `app/unocss.config.ts`, and the components named below. It is not a claim that every graph category, syntax token, legacy opacity utility, or screen has been redesigned. Browser verification and accessibility review remain separate from this document.

## Colors

### Primary

**Workbench blue** is the single interactive color family, with separate readable ink and filled-control roles. Use `--c-primary` for links and selected-action text, `--c-primary-hover` for its hover treatment, and `--c-blue` for focus and interaction indicators. Use `--c-primary-bg` and `--c-primary-bg-hover` behind `--c-text-on-primary`; do not put white text on the lighter dark-mode link ink. Selection uses `--c-selection-bg` and, where needed, `--c-selection-border`. Informational emphasis uses `--c-info` with `--c-info-bg`, not a second accent family.

### Neutral

**Paper and graphite** form the canvas (`--c-bg`), supporting surface (`--c-bg-soft`), card (`--c-bg-card`), muted/hover surface (`--c-bg-muted`), and input (`--c-bg-input`). Cards have greater luminance than the canvas in both themes; this does not imply a monotonic elevation scale across every surface token.

**Reading ink** is `--c-text`; body copy uses `--c-text-body`; secondary labels use `--c-text-secondary`; metadata uses `--c-text-muted` or `--c-text-faint`. Faint is a readable text role, not permission to make essential information nearly invisible. `--c-text-on-dark` belongs on dark content surfaces, not arbitrary light backgrounds. Code surfaces use `--c-bg-code` and `--c-bg-code-inline`; syntax highlighting is a separate domain.

Use `--c-border` for structural separation and the composer's quiet resting edge, `--c-border-soft` for quiet card edges, and `--c-border-hover` for stronger neutral edges. `--c-control-border` supplies stronger boundaries for compact fields such as rename and model search. Scrollbar thumb and hover tokens are separate from divider tokens. The retained dot grid uses `--c-grid-dot` with visible but subdued contrast against the canvas.

### Semantic state and domain color

| Role | Foreground / background | Meaning |
| --- | --- | --- |
| Success green | `--c-success` / `--c-success-bg` | Successful, connected, completed |
| Attention amber | `--c-warn` / `--c-warn-bg` | Human reply required, warning |
| Failure red | `--c-error` / `--c-error-bg` | Failed or destructive |
| Information blue | `--c-info` / `--c-info-bg` | Information that merits attention |

`--c-amber` currently matches warning ink. Git additions, modifications, deletions, renames, and diff additions retain their dedicated `--c-git-*` and `--c-diff-added` roles; they are not substitutes for UI execution status. Existing purple, indigo, teal, gradient, graph-category, and syntax palettes remain outside this unification. Do not spread those palettes into ordinary tool labels or peer-origin indicators, or silently collapse data categories into semantic status.

### Token mapping and contrast boundary

Frontmatter keys use `light-` / `dark-` followed by the CSS token suffix: for example, `light-text-secondary` records `:root`'s `--c-text-secondary`, and `dark-text-secondary` records its `.dark` override. Use CSS variables in implementation and examples; the frontmatter is the portable, normative snapshot, not a second runtime stylesheet. Unqualified component color references describe the light variant; dark variants and live examples resolve the corresponding theme variables.

The chat aliases are role mappings, not new color primitives:

| Alias | Target | Consumers |
| --- | --- | --- |
| `--c-chat-user-bg` | `var(--c-bg-muted)` | Outgoing user bubbles |
| `--c-chat-assistant-bg` | `var(--c-bg-card)` | Assistant bubbles |
| `--c-chat-action-bg` | `var(--c-bg-soft)` | Message actions, execution cards, reasoning |
| `--c-chat-border` | `var(--c-border-soft)` | Conversation card edges |

Dark mode inherits these aliases so they resolve against dark surfaces. `--c-ink` is the raw RGB channel triplet used by UnoCSS opacity utilities; it follows `--c-text`, but an opacity utility does not inherit the opaque token's contrast guarantee.

`app/src/color-design_test.ts` checks both themes: normal text tokens at least (4.5:1) against all five normal surfaces; interaction blue at least (3:1); primary ink at least (4.5:1) on normal and selected surfaces; filled primary labels at least (4.5:1); semantic ink at least (4.5:1) on its own badge and normal surfaces; the compact-field `--c-control-border` token at least (3:1). The composer's intentionally subtle resting border is not covered by that boundary threshold; it retains readable placeholder text and a stronger blue focus state. Decorative dots stay between (1.15:1) and (1.4:1) against the canvas. Empty-state decoration and disabled treatments are outside these text-pair assertions. These are focused token/role checks, not all-app WCAG certification.

**The Color Has a Job Rule.** Routine activity and identity stay neutral; semantic color must describe an action, selection, or meaningful state.

## Typography

Inter with system sans-serif fallback is the UI family. The global monospace stack is `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`; tool payloads use the shorter IBM Plex Mono / UI monospace stack recorded above.

There is no newly imposed modular type scale. The frontmatter records actual component roles: the draft heading, project heading, navigation, shared buttons, conversation text, composer, activity labels, and tool payloads. The draft heading is (500 weight) with negative tracking; project headings are (600 weight). Navigation is (13px / 20px), conversation bubbles are (0.8rem / 1.5), and the composer is (14px / 1.6). Activity is (12px / 1.5); payloads are (12px / 1.6) monospace. Do not turn these observations into a fabricated global display hierarchy.

Keep the shared UnoCSS typography preset's prose measure (65ch). A specialized full-width preview may opt out locally; do not widen every Markdown surface. Long paths, identifiers, and payloads must wrap or scroll in their intended containers rather than stretching the workbench.

**The Readable Metadata Rule.** Reduce visual emphasis with neutral hierarchy and placement before adding opacity to text.

## Layout

Preserve the existing pane-based layout. `ProjectsWorkspace.vue` defaults the resizable project sidebar to (270px); its heading has a minimum height of (48px), and its compact toolbar is (44px). The floating sidebar stays within the available width minus (40px). These are source-backed component measurements, not a universal grid.

Sidebar tokens define a grouped rhythm:

| Measurement | Desktop | Narrow / coarse pointer |
| --- | --- | --- |
| Row minimum height | 32px | 44px |
| Project heading minimum height | 36px | 44px |
| Action size | 28px | 44px |
| Outer gutter / row inset | 8px / 4px | Same tokens |
| Indent / disclosure column | 16px / 20px | Same tokens |
| Icon gap / heading gap | 8px / 4px | Same tokens |
| Group gap / section gap | 12px / 16px | Same tokens |

The shared breakpoint is `max-width: 700px`; sidebar density and shared button targets also respond to `pointer: coarse`. Folders map their tree variables to these sidebar tokens. Generic `TreeRow.vue` retains local fallbacks (34px row, 6px inset, 12px indent); do not confuse those fallbacks with sidebar overrides.

The Agent type browser separates definition browsing from runtime inspection. A compact searchable navigation list groups Built-in and Workspace definitions with quiet mode labels and neutral selection. The selected definition owns one shared heading and Overview / Tools / System prompt tabs. Overview shows only metadata actually exposed by the catalog; do not infer spawning permissions or prompt inclusion flags from missing fields. Preview channel, raw/read format and copy actions belong to the inspection views. Tools use native disclosures without nested cards; prompts share the existing sanitized renderer and preserve exact raw text for inspection and copying. A stale preview always names its original role and channel. The browser fills its workbench pane, with one scroller per column and a list-to-detail transition below (700px) of available component width, not a viewport-height calculation.

Desktop conversation rows form a centered column of `calc(100cqw - 112px)` with a (0.5rem) gap. Bubbles and message actions are content-fitting with a maximum of (80%); user bubbles align right, assistant/action rows align left. The shared `--conversation-item-max-width` caps assistant, system, compaction, tool, execution, and action rows. Some structural rows, including execution cards, request full available width **within** that cap; do not force every row to have identical intrinsic width.

Compacted-history navigation, unlinked execution traces, and the conversation summary share that same capped rail. Use transparent secondary navigation, (12px) disclosure labels, (40px) minimum rows, and (44px) touch targets on coarse pointers. Expanded execution lists and summary Markdown share a one-pixel neutral guide; execution titles wrap in quiet full-width rows rather than filled primary buttons. Summaries remain collapsed and render Markdown only when opened, with no nested vertical scroller. Initiative title, goal, scope, and non-goals live in the session-title details popover (or mobile sheet), not in a second heading row; Project coordination guidance follows the same rule.

Work realignment events keep their agent-facing instructions and JSON in the shared tool payload renderer, mounted only when expanded: (12px) monospace, secondary text on a muted surface, token-based corners, and wrapping identifiers. Event metadata uses the same chevron disclosure as other trace details, not the browser's default marker. Preserve event content and behavior; these are read-only records, not adoption controls.

Automations use the ordinary conversation workbench, opening the latest run by default. Reuse the compacted-history Previous / Next / Current controls to navigate independent run sessions, loading older pages on demand. Do not introduce a runs explorer, per-run tab strip, or secondary conversation pane. Keep read-only automation metadata behind the collapsed Automation details disclosure in the conversation, not a permanent Configuration tab. Preserve learning receipts separately from execution status. Do not add a standalone File changes workbench: retain write history as data for future context-specific detail views, without turning every write into another navigation surface.

The composer is `calc(100% - 40px)` wide, capped at (860px), changing to `calc(100% - 24px)` on narrow viewports. It owns a measured trailing history allowance through `--composer-height`. Preserve stable scrollbar gutters and the scroll container's own geometry; do not use the prose measure as the workbench's outer width.

The composer toolbar keeps its send/stop action beside the model and attachment controls. When the submit area has at most (320px) available, visually hide the shortcut/status hint rather than wrapping the toolbar; keep its live status available to assistive technology. Use the available pane space, not the window width, so sidebars and long model labels do not push the action onto a second row.

### Phone navigation and composition

At widths up to (700px), the browser application replaces stacked app/project/document/session bars with one (56px) header, plus the top safe-area inset: navigation menu, current view title/chevron, and contextual actions. Native Electron window chrome is not replaced. Desktop retains its existing headers and document tabs.

The left menu opens a drawer no wider than `min(340px, 100vw - 40px)`. Global routes and theme/account actions share it with the existing project/session tree when Chat is active; they do not create another catalog or conversation store. The current-view title opens a bottom sheet listing Conversation, Knowledge and open files. The actions sheet exposes file browsing, document closing, session details, rename, diagnosis and child-conversation return. Metadata and diagnosis are available on demand rather than permanently consuming conversation height.

The menu also opens with a deliberate rightward swipe beginning anywhere in the left half of the viewport and closes with a leftward swipe inside the drawer. After (12px) of clearly horizontal movement, the drawer follows the held finger one-to-one and the backdrop darkens proportionally. Require (64px) travel to commit on release; shorter or cancelled drags settle back. Ignore initial vertical/diagonal scrolling, multi-touch, editing controls and code surfaces. Always retain the menu button: browsers may reserve an edge gesture for their own history navigation.

Phone conversation gutters are (8px) per side, enlarged only for safe areas; do not reserve desktop history-rail space or stable two-sided scrollbar gutters. Assistant/action cards may use the full column, while right-aligned user/peer bubbles cap at (92%) to retain directional distinction. The composer and working-status card use the same outer gutters. Message history remains available as a touch-sized list under contextual actions instead of overlaying the conversation.

Phone input starts at one row, with (16px) text and (44px) minimum input/control height. Keep only the message field, plus/options and send/stop visible. Attachments, model/effort and execution location remain available through Message options. Plain Enter inserts a newline on phones; Ctrl/Command+Enter retains explicit keyboard sending. Guidance while an agent runs remains in Message options. Attachment chips and actual progress/errors stay visible; the desktop keyboard-instruction line does not consume phone space.

The phone frame and sheets follow `visualViewport.height` when available, with dynamic viewport fallback, and account for safe areas. Sheets retain labels, Escape dismissal, keyboard traversal and focus return. Drawer movement has no transition lag while dragging; its (.18s) release/button transition is disabled for reduced motion, while direct finger tracking remains. These browser implementations still require real iOS/Android checks for browser-owned gestures and software-keyboard behavior; desktop emulation is not hardware certification.

Installed web apps use the same `shadow-logo.png` source as Electron, with 192/512px manifest icons and an opaque 180px Apple touch icon. The launch/background color is graphite (`#141414`); the manifest opens a standalone window at the root without adding another navigation layer. The worker's disconnected-page fallback uses the graphite palette, system fonts (no network font dependency), a (24px) title and (16px) body. It explicitly states that conversations are unavailable offline and provides a retry link; it never fabricates an offline workspace.

## Elevation & Depth

Use flat tonal hierarchy for the conversation. Chat bubbles have no shadow; the composer relies on an input boundary. The canvas retains its dot grid (1px dots on a 20px grid), with strongly subdued theme-specific contrast. It is background texture, not a competing information layer.

Overlays retain structural depth: `ComposerPopover.vue` uses `0 12px 36px var(--c-shadow)`; floating sidebars use `8px 0 24px var(--c-shadow-soft)`. `--c-shadow-softer` supplies a light backdrop treatment. Preserve theme-specific shadow alpha and `--c-frosted` where existing translucent surfaces require it. Do not claim that every component is shadow-free: legacy scoped chat buttons still have their own hover transform/shadow.

**The Flat Conversation Rule.** Separate ordinary message roles with neutral tone, alignment, and quiet borders, not ambient card shadows.

## Shapes

All six radius tokens (`--radius-sm`, `--radius-control`, `--radius-surface`, `--radius-overlay`, `--radius-pill`, `--radius-circle`) resolve to (0px). UnoCSS rounded utilities map into this square vocabulary. Buttons, composer send control, chips, cards, inputs, and overlays remain square; the token names do not authorize rounded pills.

Custom scrollbar thumbs follow `--radius-sm`, with a six-pixel width and height. Keep native `scrollbar-width` and `scrollbar-color` styling limited to browsers without `::-webkit-scrollbar` support; non-auto values override custom thumb geometry in Chromium/Electron. The native fallback cannot control corner radius.

The circular activity spinner and its small animated center are explicit animation geometry, not a general component-radius exception. The cursor highlight is another existing decorative exception. Preserve those targeted shapes without weakening the UI corner rule.

## Components

### Buttons

Shared buttons are compact and precise: minimum height (36px), padding (7px 14px), type (13px, 500, 1.4), a one-pixel border, and square corners. Small buttons use minimum height (32px), padding (5px 10px), and (12px) type. Shared controls grow to a minimum (44px) on narrow/coarse-pointer layouts.

Primary buttons use filled primary background plus on-primary text, with the dedicated hover fill. Neutral buttons use card surface and normal text, muted hover, then selection background on active. Ghost buttons keep a transparent resting surface and muted hover/active. Keep the shared focus outline (2px `--c-blue`, 2px offset). Disabled opacity/cursor treatment is a state, not a low-contrast default for enabled actions.

### Composer and fields

The composer has padding (12px 12px 9px), a quiet one-pixel `--c-border`, input surface, and a stronger blue border on focus-within or an expanded control. Its textarea is transparent, with padding (3px 4px 10px), minimum height (78px), and maximum `min(240px, 28dvh)`. Placeholder text is secondary ink. Border-color transitions take (.15s ease). Reserve the stronger outline for interaction rather than framing the entire conversation with a high-contrast resting box.

Rename fields and model search retain `--c-control-border`. Model search preserves its visible blue focus outline; desktop window controls likewise use `--c-blue` for keyboard focus. Do not generalize these targeted updates into a claim about all legacy fields.

### Navigation

Tree rows use neutral ink and muted hover; selected rows use selection background and primary ink. Project coordination is a heading-level entry: use primary ink and a one-pixel title underline (4px offset), not a filled selection block. Its hover stays neutral and keyboard focus retains the blue outline. Maintain the icon/text/disclosure columns rather than distributing extra space between siblings. Tree icons are normally (16px); labels truncate within the row. Focus remains a visible blue outline, including the tree row's focus-within treatment.

Selected automation rows and model options use the same primary-ink/selection-background pair. The history rail distinguishes peer and event types through size and pattern rather than identity color; current, hovered, previewed, and keyboard-focused markers use interaction blue.

### Context chips

Attached context uses a soft surface, structural border, secondary text, and padding (4px 5px 4px 8px), with a (6px) gap. These are square labels with explicit remove controls, not colored status pills. Preserve the remove control's focus treatment.

Session work controls form one compact row above the composer, aligned to its
width and gutters. Decision reporting and Work alignment are square disclosure
buttons, not rounded status pills or separate permanent heading rows. Use an
(8px) gap, (32px) desktop targets and (44px) narrow/coarse-pointer targets.
Only the expanded entry uses selection color; review-needed state uses warning
ink. Each entry opens a non-modal, square popover **above** its trigger, with
the existing overlay shadow. It is teleported out of the composer layout and
never changes the toolbar or input position. Its width is capped at (520px),
with viewport gutters; height is capped at (420px) and the available space
above the trigger. Long forms scroll inside it. Switching preserves unsaved
work. Clicking outside dismisses it; Escape closes it and returns focus to its
entry. Hidden chat panes dismiss their popover. Permission and session changes still reset their
appropriate state; the toolbar does not grant backend access.

### Connection and recovery

Sidebar hover details distinguish identity, state and technical metadata.
Bot names lead at (14px) semibold, followed by a labeled connection icon, then
Platform and Bot ID below a quiet divider. Conversation details show a
state-specific icon beside their status, including inactive and unknown states.
Sidebar conversation rows use the same 16px state icons instead of square
activity dots: information blue for active, pending, or call-blocked work;
amber for replies needed; green for completion; red for failure; and neutral
ink for ready, inactive, cancelled, or unavailable states. Icon shape and the
accessible state label carry the distinction as well as color.
Session IDs have an adjacent copy icon with copied/error feedback; Bot IDs use
the same control. Copy the complete value even when its display is truncated.
Keep normal hover dismissal, keyboard entry and square controls.

Bot connection-in-progress indicators reuse the thinking indicator's three
square vertical bars (`WorkingWave`): (3px) wide, (13px) tall, with a (1.2s)
staggered scale/opacity animation. Keep the sidebar's (16px) status slot fixed.
Other connection states retain their icons; reduced-motion preferences show
static bars instead of a continuous animation.

Browser connection forms use one full-width primary submit action beneath the
input and help text. Session checks and alternative pairing methods sit in a
separate, centered column of quiet text buttons below a structural divider.
All actions keep square corners and at least (44px) targets.

Live-update, Child connection and notification-sound failures share a
right-aligned status popover over the app content, below the window chrome.
New failures reveal their recovery actions without stealing focus; clicking
outside or pressing Escape collapses them to a persistent status entry.
Repeated updates to the same failure do not reopen it. Recovery removes the
entry. None of these states changes the route's height, scroll position or
composer position. Use neutral overlay surfaces and the standard overlay
shadow, reserving warning color for the status mark rather than a full-width
banner.

### Conversation and action cards

Physical session history is navigated from the conversation heading, not from
rows above or below the messages. Use three compact Git-style node controls:
previous segment, return to current, and next segment. Next retraces visited
segments one at a time; the middle control jumps directly to the live session.
Keep all three slots stable, disable unavailable directions and navigation while
loading, and provide explicit hover/accessibility labels. On narrow or touch
layouts, targets grow to (44px); the controls remain above the conversation.

`ChatTab.vue` uses the chat aliases with a one-pixel border and padding (0.5rem 0.75rem). Peer messages preserve their source label and dashed border; source-label strong text is secondary neutral ink. An actionable source label underlines and uses normal ink on hover and exposes blue focus; sender identity itself is not teal or a success state.

`MessageAction.vue` uses content-fit width, action surface, (12px) padding, a chat border, and (13px) text. Recipient navigation is neutral at rest, underlined on hover, and blue-outlined on focus. Delivery notes and tool details stay secondary; failed results use error ink. Tool groups, execution links, and background responses share transparent (40px) trace headers, the same capped conversation rail, and one-pixel detail guides; touch targets grow to (44px). Execution headers open the child conversation (or close it when already selected); separate chevron rows expand Tool details without navigating. Detail guides appear only alongside visible content. Recognized read/write file paths use the file tree's name/extension icons; unknown paths keep the operation icon. Routine trace labels remain neutral while completion and failure use semantic status ink. Reasoning uses neutral headers and a quiet action surface, not warning amber.

`ConversationEvent.vue` uses a square action surface and one-pixel chat border on that same capped rail, without nested vertical guides. Headers group a (13px) title above a (12px) neutral source line; timestamp and disclosure/navigation icons stay at the trailing edge. Source labels truncate with their full text available as a title, while event titles and bodies wrap. Headers and body use (12px) padding; body Markdown keeps a (72ch) reading measure. Completion icons use success ink, failed icons/titles use error ink, and cancellation stays neutral. Selected completion links use selection background and border. Completion headers inspect the linked execution; Event details expands content and metadata separately without navigating. Other events retain native disclosure and an explicit execution link when available. Metadata uses (12px) label/value columns, monospace values, and a single column below (440px) of event width. Actions and disclosures retain (44px) narrow/coarse-pointer targets. Execution completion never implies a verified learning outcome.

### Activity and tool details

`SessionActivity.vue` uses neutral secondary ink for routine LLM/tool/idle states, success for completed, error for failed, and warning for waiting on a human. Inactive/unknown uses muted ink. The spinner is (14px), inside a (16px) symbol slot, with a (.8s linear) rotation disabled by `prefers-reduced-motion: reduce`. Labels carry the state in words; color alone is not the explanation.

`ToolActivityGroup.vue` keeps running status and ordinary trace/payload information neutral; actual failures remain red. Global fade/slide helpers use (.3s ease), while existing local animations have their own durations. Do not introduce a new system-wide animation scale or claim every animation already has reduced-motion handling.

Diagnosis USER, SESSION, ASSISTANT, TOOL, and CONTEXT badges are neutral text labels, not a role-color legend. Routine log trace/debug/info levels remain neutral; warn and error use their corresponding semantic colors. Background-task running indicators are neutral. Bot connectivity uses success green only for connected state and amber for restart-required state; connecting and running remain neutral.

The ten examples in `.impeccable/design.json` are dependency-free visual excerpts from these existing patterns, not replacement Vue implementations. They inherit live theme variables; interactive controls include hover/focus styles, while static cards do not acquire fake interaction.

### Device setup and pairing

Device setup is an **Operate** surface: reach a real connected execution
location with minimal ceremony. Main and Child remain explicit roles, not
decorative device types. Main's Nodes page introduces network configuration,
then a short-lived invitation, then a pending fingerprint comparison. Keep the
inventory available rather than replacing it with a full-page setup wizard.

Pairing uses one copy on Main and one paste on Child. The primary invitation
action copies the address, offer ID, PIN and expiry together; Child shows the
parsed Main address for review. Protocol fields belong behind manual-transfer
or manual-entry controls, not in the default form. Clipboard failure keeps a
selectable invitation available. Invitations remain private, short-lived and
single-use; pasting does not grant transport or execution consent.

Use the existing neutral card/input surfaces, quiet structural borders and
square controls. The next deliberate action uses interaction blue; an actual
authenticated connection uses success ink. Pending human approval and the
unencrypted-network warning use attention ink with explanatory text. Offline
is neutral, and failed setup is an explicit error with a retry path. Neither a
submitted PIN nor a locally started backend earns a green connected state.

Identity and invitation values use the existing monospace treatment and must
wrap without horizontal overflow. Fingerprint verification and execution trust
are explicit user decisions, never preselected checkboxes. Keep HTTP risk copy
adjacent to its opt-in, explain OS-user execution privileges, and distinguish
device pairing from browser login. Do not imply a sandbox or per-command
permission system. Controls preserve keyboard focus, labelled fields and the
shared narrow/coarse-pointer touch sizes.

## Do's and Don'ts

### Do
- Do use shared CSS variables and inherited chat aliases in both themes.
- Do reserve blue for interaction, selection, and information needing attention.
- Do reserve green for success, connection, or completion; amber for human attention or warnings; red for failures or destructive actions.
- Do preserve neutral source labels, routine tool activity, thinking outside compact sidebar status, idle state, and static trace information.
- Do retain the sidebar rhythm, square corners, content-fitting message cards, and the shared prose measure.
- Do verify actual foreground/background pairs and focus states when adding or changing a component.

### Don't
- Don't replace neutral reading surfaces with colored sender or tool-type panels.
- Don't use dark-mode primary link ink as a filled button background behind white text.
- Don't add shadows to ordinary chat bubbles or round controls because a token is named pill or circle.
- Don't treat muted/faint text or decorative border tokens as interchangeable with disabled content or input boundaries.
- Don't repurpose Git, syntax, graph-category, or legacy specialty colors as general interaction/status tokens.
- Don't infer app-wide accessibility certification or a complete legacy-style migration from focused palette tests.
