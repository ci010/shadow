import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotSettingsClient, parseBotCatalog, parseBotList } from './bot-settings.ts'

const bot = {id:'qq-1', projectId:'p', platform:'qq', displayName:'Named QQ', label:'QQ', enabled:true, configured:true, state:'connected', config:{appId:'synthetic',futureOption:true},secrets:{secret:true}}
test('sidebar facts survive settings schema drift while management parsing stays strict', () => {
  const value = {channels:[bot,{...bot,id:'discord-1',platform:'discord',displayName:'Named Discord',config:{},secrets:{}}]}
  assert.throws(() => parseBotList(value,'p'))
  const catalog = parseBotCatalog(value,'p')
  assert.deepEqual(catalog.map(b => [b.displayName,b.connection?.state]), [['Named QQ','connected'],['Named Discord','connected']])
  assert.equal('config' in catalog[0],false)
  assert.equal(parseBotCatalog({channels:[{...bot,state:'future-state'}]},'p')[0].connection,undefined)
  assert.throws(() => parseBotCatalog({channels:[{...bot,projectId:'other'}]},'p'))
  assert.throws(() => parseBotCatalog({channels:[bot,bot]},'p'))
})
test('catalog preserves project path and denial, never fabricates connection', async () => {
  const client = createBotSettingsClient('http://localhost/projects/p','p', async input => {
    assert.equal(new URL(String(input)).pathname,'/projects/p/api/channels')
    return Response.json({channels:[bot]})
  })
  assert.equal((await client.catalog())[0].connection?.state,'connected')
  const denied = createBotSettingsClient('http://localhost/projects/p','p',async () => new Response('',{status:401}))
  await assert.rejects(denied.catalog())
})
