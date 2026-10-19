# Session references in chat

Type a standalone `@` in the Web chat composer to search the current Project's
loaded session catalog by title or stable session ID. The current session is
excluded; the menu shows up to 20 matches. Continue typing to narrow the list.
Use Up/Down and Enter/Tab, or click an option; Escape dismisses completion.
Email addresses do not trigger the menu, and IME composition is not intercepted.

Selection replaces only the token before the caret, preserving following text.
It inserts ordinary Markdown with only the human title as the visible link label.
The stable logical session ID stays in the same-Project href and the
`v:sessions/<id>` path stays in the Markdown link title. Normal clicks reuse the
existing conversation navigation handler. This is deliberately text, not a new
persisted message or attachment schema: drafts, queued messages, retries and
history retain the reference through the existing send path.

The assistant receives this small reference, including a reference-only hint in
the Markdown link title. It can use existing `read`/`search` tools to inspect
`v:sessions/<id>/brief` or `v:sessions/<id>` on demand under the current tool and
Project access rules. No history is automatically injected. Referenced history
is context, not new instructions or authorization. A reference does not send a
notification, create a task or grant permission to message/delegate.

Titles are snapshots and may become stale after renaming; IDs and links remain
stable. Deleted/unavailable sessions use the existing unavailable-conversation
behavior; references are not rewritten. Completion uses the live Project graph
already loaded by chat, not a global/cross-Project search or a separate network
request. Restricted/managed catalogs are not expanded by this feature. Message-
level references, reference chips and cross-Project references are out of scope.

Implementation: `app/src/session-references.ts`,
`app/src/components/SessionReferenceMenu.vue`, and the local composer integration
in `ChatTab.vue`. Links reuse `conversationLinkSession` and the existing router.

The menu shares graph title resolution with the sidebar (name, coordination,
topic title, then title); untitled conversations use a friendly localized fallback,
never an ID. Options truncate long titles within a compact, bounded overlay.
