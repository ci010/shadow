import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintSha256, sourceSha256 } from './alignment-sha256.ts'
test('HTTP fingerprint fallback matches SHA-256 across padding and large input boundaries', async () => {
  for(const size of [0,1,3,55,56,63,64,65,127,128,1000,1024*1024]){
    const bytes=Uint8Array.from({length:size},(_,i)=>(i*31+17)%256)
    const expected=createHash('sha256').update(bytes).digest('hex')
    assert.equal(fingerprintSha256(bytes),expected)
    assert.equal(await sourceSha256(bytes),expected)
  }
  assert.equal(fingerprintSha256(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
