import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionPromptContext } from './builder.ts'
import { toolsGuideline } from './tools-guideline.ts'
import { getBuiltinSkills } from '../../skills/builtins.ts'
import { Bus } from '../../bus/bus.ts'
import { MessageTool } from '../../tools/message.ts'
import { createWorkTools } from '../../tools/work-operations.ts'
import type { WorkAlignment } from '../../sessions/work-alignment.ts'

const ctx: SessionPromptContext = {
  behavior: {}, channel: 'web', chatId: 'fixture', sessionId: 'web:fixture',
  agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' },
}
const restricted = (allowedTools: string[]): SessionPromptContext => ({
  ...ctx, agent: { ...ctx.agent, allowedTools },
})

test('peer inspection is read-first even without peer creation or messaging capabilities', () => {
  for (const context of [ctx, restricted(['read', 'search'])]) {
    const prompt = toolsGuideline(context)
    for (const rule of [
      /read its brief and relevant history\/tool results at `v:sessions\/<sessionId>` and existing Work first/,
      /Observation is read-only: do not send status inquiries or acknowledgement requests/,
      /Report missing\/stale evidence as uncertainty, not a reason to ping or poll/,
      /only when the user requests interaction or necessary information\/action cannot be obtained by reading/,
    ]) assert.match(prompt, rule)
  }
  const readOnly = toolsGuideline(restricted(['read', 'search']))
  assert.doesNotMatch(readOnly, /### Messaging|v:tools\/session|v:skills\/peer-sessions|work_create/)
})

test('direct interaction stays light and shared commitments progressively use existing Work', () => {
  const prompt = toolsGuideline(ctx)
  for (const rule of [
    /Message is free-form direct interaction for questions, discussion or one-off coordination/,
    /not a status-read API/,
    /Do not send routine acknowledgements/,
    /When an exchange develops a durable dependency or shared commitment, prefer existing Work/,
    /keep discussion in message/,
    /Reuse relevant Work before creating it; one-off exchanges need no record/,
    /Update only meaningful changes; rely on targeted Work notifications rather than duplicate messages/,
    /Do not send duplicate Work updates/,
    /Work is not a prerequisite or permission/,
    /Use reply for pending requests; final addresses the current reader/,
  ]) assert.match(prompt, rule)
  const messagesOnly = toolsGuideline(restricted(['read', 'message']))
  assert.match(messagesOnly, /free-form direct interaction/)
  assert.doesNotMatch(messagesOnly, /prefer existing Work|work_create|### Shared work notes/)
})

test('peer routing does not become a task/call coordination prerequisite', () => {
  for (const mode of ['task', 'call'] as const) {
    const prompt = toolsGuideline({ ...ctx, mode })
    assert.doesNotMatch(prompt, /### Peer conversations|Message is free-form|When an exchange develops|v:skills\/work-coordination/)
    if (mode === 'task') assert.match(prompt, /same-assignment corrections/)
    else assert.doesNotMatch(prompt, /### Messaging/)
  }
})

test('message and typed Work descriptions agree with the inline tool selection rules', () => {
  const message = new MessageTool(new Bus(), () => true, () => undefined, () => [], async (sessionId, input) =>
    ({ status: 'accepted', sessionId, inputId: input.id }))
  assert.match(message.description, /Free-form direct interaction/)
  assert.match(message.description, /read v:sessions history and existing Work first/)
  assert.match(message.description, /do not ping for readable status/)
  assert.match(message.description, /Prefer Work for durable shared facts\/dependencies/)
  assert.match(message.description, /Admission is not application or ownership transfer/)
  const work = createWorkTools({} as WorkAlignment)
  assert.match(work.find(tool => tool.name === 'work_create')!.description, /Reuse relevant Work first; one-off discussion belongs in message and observation in read/)
  const update = work.find(tool => tool.name === 'work_update')!.description
  assert.match(update, /Routine progress stays silent/)
  assert.match(update, /entering done\/blocked can notify the Work manager/)
  const comment = work.find(tool => tool.name === 'work_note_create')!.description
  assert.match(comment, /silent unless notifyManager is true/)
  assert.match(comment, /notifies the original author/)
  assert.match(comment, /not delivered, approved or read/)
  assert.match(update, /Do not send a duplicate message/)
  assert.match(update, /not acceptance or permission to execute/)
})

test('on-demand collaboration Skills explain observation, progressive state and actual notification limits', async () => {
  const skills = await getBuiltinSkills()
  const peers = skills.get('peer-sessions')!.body
  const work = skills.get('work-coordination')!.body
  for (const rule of [
    /Start with the overview and narrow to relevant evidence/,
    /not by itself a request to contact it/,
    /not elapsed time or message count/,
    /record its agreed outcome in Work within/,
    /Do not send routine acknowledgements/,
  ]) assert.match(peers, rule)
  for (const rule of [
    /Do not require Work before first contact/,
    /not three manual agent steps/,
    /a commit existing does\s+not mean its interface is stable/,
    /Do not mark the whole Work\s+done merely to obtain a notification/,
    /not a general peer subscription/,
    /outside\s+supported routing, use one actionable message referencing the Work/,
    /read latest Work before acting/,
    /does not grant authorization or enforce a file\/Git lock/,
  ]) assert.match(work, rule)
})
