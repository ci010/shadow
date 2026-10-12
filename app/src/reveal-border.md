# Reveal border

`App.vue` installs and disposes the DOM-only controller in `reveal-border.ts`.
The opt-ins are provider cards, work-item cards (list entries), the conversation
composer box, and ordinary `.chat-bubble.chat-user` / `.chat-bubble.chat-assistant`
message cards (including the streaming assistant), plus the shared
`.message-preview-card` shell used by task executions, task-completion events,
and incoming/outgoing session messages. Their expanded cards may be tall or
wide: a long reply still reveals along its side perimeter, not its distant centre.
Other opt-ins taller than 320px or wider than 1000px remain excluded. Large panels,
navigation and arbitrary controls are not opted in. Execution-selected and
event-selected borders also suppress decoration.

The perimeter receives a masked 1px radial highlight within 72px of a fine mouse
pointer, including outside the target and on adjacent targets. Maximum proximity opacity is 0.7. It fades over
180ms when the pointer leaves or moves away. Light and dark tokens use a subtle cool tint,
not semantic status colors. Original borders, backgrounds, outlines and layout
are unchanged. Decoration is a local `::after`, with no global z-index, so
ancestor scrolling/overflow and normal dialog stacking still apply.

Selected/active/current, focus-within, invalid/error, disabled (including disabled
fieldsets), inert/hidden, attachment-drop, answering/working and open composer
controls suppress Reveal. Reduced motion disables it entirely; coarse/touch
input does not activate it. Scroll, resize, window blur, document leave/cancel
and visibility changes clear it. Only pointer events schedule work; bursts share
one rAF and geometry reads precede CSS-property writes. There are no Vue state
updates or idle animation loops. The global mouse-glow follower has been removed from App, including its
mousemove listener, perpetual animation loop, template and styles.

An initial subtree scan registers targets with IntersectionObserver (72px viewport
reach margin). Mouse frames read geometry only for its intersecting shortlist:
work scales with visible/near-viewport cards, not total history. Fresh reads handle
streaming growth without caching stale rectangles. This is not a fixed numerical
cap: many overlapping visible cards can still increase the shortlist. A scoped
MutationObserver on the document element registers added subtrees and reconciles
Vue class reuse/removal; it watches childList and class only, not pointer-written
styles or streaming text. Own decoration-class mutations are ignored. Removed
subtrees are walked once per removal record and checked for registry membership,
including nodes whose opt-in classes changed before removal. No per-removal full
registry containment scan remains; streaming text and added leaf elements do not
run descendant queries. Only previously active cards are cleared on a mouse frame.
Transparent decoration is reclaimed by a one-shot 220ms cleanup after the 180ms
fade. Reactivation cancels that cleanup; removal and disposal cancel outstanding
timers. Identical calculated coordinates/opacity cause no style writes or class
adds. Geometry is deliberately still read on repeated identical mouse coordinates:
streaming growth, layout/style changes, ancestor transforms and semantic exclusions
can change the result without moving the pointer. There is no stale rectangle cache. Disposal disconnects both observers,
cancels pending frames, removes listeners and clears decoration. Engines without
these observers fail closed rather than scan the entire history each frame.

## Opting another surface in

Use `.reveal-border` only on a small bordered container (not a native input,
large panel or every button). Reserve its `::after` for this effect and ensure
`position: relative` is appropriate; do not opt in components already using that
pseudo-element. Mark semantic/custom states with `data-reveal-disabled` when
the built-in state selectors do not cover them. An opt-in container should own
its border rather than depend on a child's outline. Review clipping, popover
positioning and both themes when adding targets.

## Focused verification

- `pnpm exec node --import tsx --test app/src/reveal-border_test.ts app/src/reveal-border-rendered_test.ts`
- `pnpm --dir app typecheck`

The rendered test uses a disposable Vite/Electron synthetic fixture, not real
sessions. It checks external proximity and neighboring targets, state exclusion,
layout preservation, fade/scroll/leave/cancel clearing, rAF coalescing, touch,
coarse-pointer and reduced-motion changes, large-panel limits, overflow/dialog
raster clipping, and disposal. It also renders the actual user/assistant class
combinations with a 520px reply and streaming growth, dynamic class reuse, and a
2,000-message scrolling list. Browser instrumentation asserts 1–20 target geometry
reads per settled pointer update (eight repeated updates plus a middle-history
scroll), zero selector rescans per update, zero Reveal style writes/class adds on
eight unchanged-pointer updates, and zero containment checks/selector rescans for
100 leaf removals with streamed text in that history. It verifies visible fade,
transparent decoration reclamation and reactivation before cleanup, plus both
observers disconnected on disposal. Current observed counts: 14 geometry reads
per repeated update, 15 after scrolling; all measured scans/writes/containment
checks above were zero. These deterministic operation-count limits are fixture-specific, not a
wall-time performance guarantee. Its light/dark before/near and long-reply PNGs are saved
in `.test-artifacts/reveal-border-preview/`. On Linux without a display server,
the Electron test skips. This fixture does not constitute full-app visual QA.

## Painting limitation

The unchanged local masked pseudo-element still spans the entire card. Its radial
highlight is visually local, but large expanded messages may require browser
raster/mask work over a large surface while active. Operation counts above measure
DOM/controller work, not GPU raster cost or full-app frame time. No measured paint
bottleneck justified a partial-border renderer in this change; replacing the mask
would require independent paint profiling and clipping/radius/visual equivalence
verification. Cleanup removes transparent pseudo-elements rather than retaining
historical large masked surfaces indefinitely. No CSS, strength or target changes
were made for this optimization.

Conversation chips (`.chat-working`, `.context-chip`, and `.session-work-triggers > button`)
also opt in. Their resting border uses `--c-border`; waiting and expanded task
chips retain semantic/state boundaries and suppress Reveal.
