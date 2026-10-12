import type { ChatMessage } from '../../providers/provider.ts'
import { hasNoAdmittedUserInput, type ResponseContext } from '../../sessions/response-context.ts'

export function withResponseAudience(messages: ChatMessage[], context: ResponseContext | undefined): ChatMessage[] {
  if (!context) return messages
  const guidance = `## Current Turn: Response Audience

Your final response is automatically delivered to the reader of this conversation.
It is not delivered to another session. Use message for ordinary peer communication;
use reply for a specific pending request, if permitted. Message receipts confirm
admission, not completion or agreement. Final text does not answer pending requests.
${hasNoAdmittedUserInput(context)
    ? `This turn was triggered by ${context.source.kind === 'session' ? 'another session' : 'an event'}, with no user input admitted to this turn.
Handle the input under the existing work and authorization constraints, not as a new user request.
The trigger describes provenance, not the response audience or whether the user's work is complete.
Address the conversation's user, not the triggering agent/event. If this input advances or completes
an earlier user request (including asynchronous work), answer that request normally with the necessary
results, verification, limitations and next steps. Do not force a short background summary.
For an independent update, be brief and self-contained. Preserve necessary context and failures;
do not repeat routine coordination, acknowledgements or tool receipts. If the result was already
incorporated and changes no outcome, risk, blocker or required action,
return no user-facing text instead of another acknowledgement.
Do not imply the user just asked this question.`
    : `This response continues a user request admitted in this turn or an unfinished prior turn.
Answer the user's request normally, even if
other sessions or events also contributed context. Do not force a short background summary.`}`
  return messages[0]?.role === 'system'
    ? messages.map((message, index) => index === 0
      ? { ...message, content: `${String(message.content ?? '')}\n\n${guidance}` } : message)
    : [{ role: 'system', content: guidance }, ...messages]
}
