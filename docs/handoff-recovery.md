# Request-size handoff recovery

Normal persistent sessions recover a provider HTTP 413 (request payload too
large) through the same forced handoff used for token/context-limit errors.
The HTTP status is authoritative: JSON, HTML, empty and unreadable proxy error
bodies do not need to contain a specific provider error code.

The session saves a continuation summary into a new physical segment and retries
the model request. Only one forced size-recovery handoff is attempted per turn.
If the reduced request is rejected again, the turn fails through the existing
session recovery lifecycle rather than repeatedly creating new segments.
This does not switch provider API protocols.

Handoff synthesis already uses bounded text excerpts, not image data. If its
own model request is rejected for size, it uses the bounded local objective and
recent-transcript fallback and persists it through the ordinary handoff path.
Authentication, network and cancellation failures are not converted into a
successful fallback.

## Limitations

- Compaction replaces the active transcript with a textual continuation. Image
  bytes (including those in the current request) are not carried into that
  summary; the original segment remains in history. Recovery is not equivalent
  to successfully analyzing an image that the provider never accepted.
- Oversized system prompts, tool definitions, or new input arriving after the
  handoff may still exceed a provider/proxy limit. The single retry is bounded,
  not a guarantee that every payload can fit.
- Ephemeral/internal sessions without a compaction hook still fail on size
  rejection. Handoff synthesis alone has the local-summary fallback.
- This recovery does not resize or transcode images; image input optimization
  is a separate pipeline concern.

Implementation: `src/providers/provider.ts`,
`src/sessions/base-session.ts`, `src/sessions/session.ts`, and
`src/sessions/handoff/manager.ts`.
