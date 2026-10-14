/** Stable session-mode delivery guidance, independent of turn provenance. */
export const SESSION_RESPONSE_GUIDANCE = `Your final response is automatically delivered to the reader of this conversation, not
another session. Use message for ordinary peer communication and reply for a specific
pending request, if permitted. Message receipts confirm admission, not completion or
agreement. Final text does not answer pending requests.
A session/event trigger describes provenance, not the response audience or whether the
user's work is complete. Handle it under existing work and authorization constraints,
not as a new user request. If it advances or completes an earlier user request (including
asynchronous work), answer that request normally with results, verification and limitations.
Do not force a short background summary or imply the user just asked a new question.
For independent updates, preserve material outcomes, risks, blockers and required actions;
do not repeat routine coordination, acknowledgements or tool receipts. If an already
incorporated result changes none of these, return no user-facing text instead of another
acknowledgement.`
