import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Watermarks } from './store.ts'
import { WatermarkTool } from '../tools/watermark.ts'
test('durable ack, retry fencing, optimistic conflict and Project guard', () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-watermark-'))
  try {
    const s = new Watermarks(root, 'p', 'c')
    const stale = new Watermarks(root, 'p', 'c')
    const b = s.prepare('discord:channel:1', null, '123')
    assert.throws(() => stale.prepare('other', null, '1'), /conflict/)
    s.claim(b.id, 'a'); s.retry(b.id, 'a', 'network failed')
    assert.equal(s.inspect().cursors[b.source], undefined)
    s.claim(b.id, 'b')
    assert.throws(() => s.ack(b.id, 'a'), /Stale/)
    s.ack(b.id, 'b'); s.ack(b.id, 'b')
    assert.equal(new Watermarks(root, 'p', 'c').inspect().cursors[b.source], '123')
    assert.throws(() => new Watermarks(root, 'other', 'c'), /mismatch/)
    assert.throws(() => s.prepare(b.source, null, '124'), /conflict/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('agent tool refuses missing project context', async () => {
  await assert.rejects(new WatermarkTool('unused', 'p').execute({action:'inspect',consumer:'c'}), /Project/)
})
test('agent bookkeeping is isolated by logical session and consumer', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-watermark-tool-'))
  try {
    const tool = new WatermarkTool(root, 'p')
    const context = { sessionId: 'one', projectId: 'p' } as NonNullable<Parameters<typeof tool.execute>[1]>
    const b = JSON.parse(await tool.execute({action:'prepare', consumer:'c', source:'s', to:'1'}, context))
    await assert.rejects(tool.execute({action:'claim',consumer:'c',id:b.id,attempt:'a'}, { ...context, sessionId:'two' }), /Unknown/)
    await assert.rejects(tool.execute({action:'inspect',consumer:'c'}, {...context, projectId:'other'}), /Project/)
    await tool.execute({action:'claim',consumer:'c',id:b.id,attempt:'a'}, context)
    await tool.execute({action:'retry',consumer:'c',id:b.id,attempt:'a',error:'restart'}, context)
    await assert.rejects(tool.execute({action:'claim',consumer:'c',id:b.id,attempt:'a'},context), /unique/)
    const state = JSON.parse(await tool.execute({action:'inspect',consumer:'c'},context))
    assert.equal(state.batches[0].state,'pending')
  } finally { rmSync(root, {recursive:true,force:true}) }
})
test('tool restart exposes running attempt and permits explicit recovery without cursor advance', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-watermark-recover-'))
  try {
    const context = {sessionId:'one',projectId:'p'} as NonNullable<Parameters<WatermarkTool['execute']>[1]>
    const call = (args: Record<string, unknown>) => new WatermarkTool(root,'p').execute({consumer:'c',...args},context)
    const b = JSON.parse(await call({action:'prepare',source:'s',to:'new'}))
    await call({action:'claim',id:b.id,attempt:'before-crash'})
    const restored = JSON.parse(await call({action:'inspect'}))
    assert.equal(restored.batches[0].state,'running')
    const attempt = restored.batches[0].attempts.at(-1)
    await call({action:'retry',id:b.id,attempt,error:'restart recovery'})
    await call({action:'claim',id:b.id,attempt:'after-crash'})
    await assert.rejects(call({action:'ack',id:b.id,attempt}),/Stale/)
    assert.deepEqual(JSON.parse(await call({action:'inspect'})).cursors,{})
    await call({action:'ack',id:b.id,attempt:'after-crash'})
    assert.equal(JSON.parse(await call({action:'inspect'})).cursors.s,'new')
  } finally { rmSync(root,{recursive:true,force:true}) }
})
