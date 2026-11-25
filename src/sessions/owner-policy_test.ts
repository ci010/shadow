import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOwnerSession } from './owner-policy.ts'
import type { SessionState } from './session-store.ts'
test('owner session eligibility preserves non-default Project and legacy durable mode but rejects children and foreign actors', () => {
  const state: SessionState = {sessionId:'web:owner',projectId:'non-default',segmentIndex:0}
  assert.equal(isOwnerSession(state,'non-default'),true)
  assert.equal(isOwnerSession({...state,mode:'session'},'non-default'),true)
  for (const patch of [{projectId:'default'},{sessionId:'discord:owner'},{parentSessionId:'web:parent'},{mode:'task' as const},{mode:'call' as const}]) {
    assert.equal(isOwnerSession({...state,...patch},'non-default'),false)
  }
})

test('BOT ownership follows only live same-Project Web execution lineage', async () => {
  const { botWebExecutionOwner } = await import('./owner-policy.ts')
  const root: SessionState = {sessionId:'web:root',projectId:'p',segmentIndex:0}
  const states = new Map<string, SessionState>([[root.sessionId, root]])
  const owner = (id: string) => botWebExecutionOwner(id, 'p', id => states.get(id))
  assert.equal(owner('web:root'), 'web:root')
  for (const mode of ['session','task','call'] as const) {
    const id = `virtual:${mode}`
    states.set(id, {...root,sessionId:id,mode,parentSessionId:'web:root'})
    assert.equal(owner(id),'web:root')
  }
  states.set('virtual:nested',{...root,sessionId:'virtual:nested',mode:'call',parentSessionId:'virtual:task'})
  assert.equal(owner('virtual:nested'),'web:root')
  for (const patch of [{projectId:'foreign'}, {automation:{}}, {sessionId:'qq:service'}, {parentSessionId:'missing'}, {parentSessionId:'virtual:bad'}, {parentSessionId:undefined,workspaceRoot:'web:root'}, {parentSessionId:undefined,parent:{id:'web:root'}}]) {
    const state = {...root,sessionId:'virtual:bad',mode:'task',parentSessionId:'web:root',...patch} as SessionState
    states.set(state.sessionId,state)
    assert.equal(owner(state.sessionId), undefined)
  }
})
