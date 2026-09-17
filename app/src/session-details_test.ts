import assert from 'node:assert/strict'
import test from 'node:test'
import { contextPercent, formatTokenCount, parseSessionDetails, type SessionDetails } from './session-details.ts'

const details: SessionDetails = {
  sessionId: 'web:chat-example',
  name: 'Inspect the source',
  workdir: { kind: 'local', displayPath: 'C:\\folders\\shadow' },
  usage: { promptTokens: 40_000, completionTokens: 5_000, totalTokens: 45_000 },
  usageScope: 'session',
  context: { usedTokens: 20_000, windowTokens: 100_000 },
}

test('session details preserve actual paths and distinguish context from lifetime tokens', () => {
  const parsed = parseSessionDetails(details, details.sessionId)
  assert.deepEqual(parsed, details)
  assert.equal(contextPercent(parsed.context), 20)
  assert.equal(formatTokenCount(40_000), '40K')
  assert.equal(formatTokenCount(1_250_000), '1.3M')
})

test('unreported usage and remote paths remain unknown rather than fabricated', () => {
  const parsed = parseSessionDetails({
    ...details, name: null, workdir: { kind: 'remote', displayPath: null }, usage: null,
    context: { usedTokens: null, windowTokens: null },
  }, details.sessionId)
  assert.equal(parsed.workdir.displayPath, null)
  assert.equal(parsed.usage, null)
  assert.equal(contextPercent(parsed.context), null)
  assert.equal(contextPercent({ usedTokens: 0, windowTokens: 100_000 }), 0)
  assert.equal(contextPercent({ usedTokens: 120_000, windowTokens: 100_000 }), 120)
})

test('remote details retain display-only device identity and current availability', () => {
  const workdir = {
    kind: 'remote', nodeId: 'wsl', nodeName: 'WSL Ubuntu',
    displayName: 'Test workspace', displayPath: '/home/user/workdir', available: false,
  }
  assert.deepEqual(parseSessionDetails({ ...details, workdir }, details.sessionId).workdir, workdir)
  for (const invalid of [{ nodeId: 1 }, { nodeName: {} }, { displayName: null }, { available: 'online' }]) {
    assert.throws(() => parseSessionDetails({ ...details, workdir: { ...workdir, ...invalid } }, details.sessionId), /session details/)
  }
})

test('session details reject cross-session, malformed and nonfinite measurements', () => {
  for (const value of [
    null, [], {}, '<html>old backend</html>', { ...details, sessionId: 'another-session' },
    { ...details, workdir: { kind: 'local', displayPath: 123 } },
    { ...details, usageScope: 'estimated' },
    { ...details, usage: { ...details.usage, totalTokens: -1 } },
    { ...details, usage: undefined },
    ...[-1, 1.5, Infinity, NaN, '100'].map(usedTokens => ({ ...details, context: { ...details.context, usedTokens } })),
    { ...details, context: { usedTokens: 2, windowTokens: 0 } },
  ]) assert.throws(() => parseSessionDetails(value, details.sessionId), /session details/)
})
