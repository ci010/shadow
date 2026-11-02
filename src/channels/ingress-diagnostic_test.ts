import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelAdmissionError } from './base.ts'
import { IntegrationError } from './integration-store.ts'
import { ingressDispatchEvent, ingressErrorDetail, markIngressFailure } from './ingress-diagnostic.ts'

test('ingress diagnostics classify actionable failures without serializing private error fields', () => {
  const privateText = 'private user message token=secret signed-url'
  const inner = Object.assign(new Error(privateText), {code:'ENOSPC',request:{body:privateText}})
  markIngressFailure(inner,'stream')
  const outer = new Error(privateText,{cause:inner})
  assert.equal(ingressErrorDetail(outer),'phase=dispatch category=unknown cause={phase=stream category=system:ENOSPC}')
  assert.equal(ingressErrorDetail(new ChannelAdmissionError('No input listener subscription; policy not executed',403)), 'phase=dispatch category=admission:listener_missing')
  const denied = new IntegrationError('channel_access_denied',privateText,403)
  markIngressFailure(denied,'admission')
  assert.equal(ingressErrorDetail(denied),'phase=admission category=integration:channel_access_denied')
  assert.equal(ingressErrorDetail(new IntegrationError(privateText,privateText)), 'phase=dispatch category=integration')
  assert.equal(ingressErrorDetail(privateText),'category=non_error')
  assert.equal(ingressDispatchEvent(privateText),'other')
  assert.equal(ingressDispatchEvent('MESSAGE_CREATE'),'MESSAGE_CREATE')
  assert.equal(ingressDispatchEvent('GROUP_AT_MESSAGE_CREATE'),'GROUP_AT_MESSAGE_CREATE')
})
test('bounded cause inspection handles cycles and hostile properties without leaking values', () => {
  const error = new Error('private')
  error.cause=error
  assert.equal((ingressErrorDetail(error).match(/category=/g)??[]).length,3)
  Object.defineProperty(error,'code',{get(){throw new Error('private')}})
  assert.equal(ingressErrorDetail(error),'phase=dispatch category=uninspectable')
})
test('first failure stage wins and original authorization error identity is unchanged', () => {
  const error = new ChannelAdmissionError('private',403)
  markIngressFailure(error,'admission');markIngressFailure(error,'stream')
  assert.equal(ingressErrorDetail(error),'phase=admission category=admission:denied')
  assert.ok(error instanceof ChannelAdmissionError)
  assert.equal(error.status,403)
})
