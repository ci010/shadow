import assert from 'node:assert/strict'
import test from 'node:test'
import { gradeQualityAnnotation, qualityCases, type QualityAnnotation } from './quality-evaluation-fixtures.ts'

for (const fixture of qualityCases) {
  const valid: QualityAnnotation = { ...fixture.expected, claims: [], refs: [fixture.source] }
  test(`quality rubric accepts evidenced retain/omit/correct: ${fixture.id}`, () => {
    assert.deepEqual(gradeQualityAnnotation(fixture.id, valid), [])
  })
  test(`quality rubric rejects lost provenance and unsupported claims: ${fixture.id}`, () => {
    const errors = gradeQualityAnnotation(fixture.id, { ...valid, refs: [], claims: [...fixture.forbidden] })
    assert.ok(errors.includes('source'))
    assert.equal(errors.filter(error => error.startsWith('unsupported:')).length, fixture.forbidden.length)
  })
}

test('pending implementation is not a reason to discard a stable human constraint', () => {
  const f = qualityCases[0]
  assert.deepEqual(gradeQualityAnnotation(f.id, {
    ...f.expected, action: 'omit', destination: 'none', rationale: 'implementation-pending', refs: [f.source], claims: [],
  }), ['action', 'destination', 'rationale'])
})
test('already consolidated knowledge must not produce another page or claimed reuse', () => {
  const f = qualityCases[1]
  assert.deepEqual(gradeQualityAnnotation(f.id, {
    ...f.expected, action: 'retain', destination: 'new-page', claims: ['reuse-proven'], refs: [f.source],
  }), ['action', 'destination', 'unsupported:reuse-proven'])
})
test('later attributed evidence corrects unknown status without upgrading to verification', () => {
  const f = qualityCases[3]
  assert.deepEqual(gradeQualityAnnotation(f.id, {
    ...f.expected, attribution: 'independent-verification', claims: ['image-cause-proven'], refs: [f.source],
  }), ['attribution', 'unsupported:image-cause-proven'])
})
test('finish boundary cannot turn useful but unpersisted evidence into applied', () => {
  const f = qualityCases[4]
  assert.ok(gradeQualityAnnotation(f.id, { ...f.expected, action: 'applied', claims: [], refs: [f.source] }).includes('action'))
})
