import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BotInstanceStore } from './bot-store.ts'
import { ServiceDiscoveryStore } from './service-discovery.ts'
import { serviceGroupsPlugin } from './service-groups.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../agent-authoring/bot-runtime.ts'

test('observed groups use deployed directory bindings and expose no resource publication endpoint',async t=>{
  const root=mkdtempSync(join(process.cwd(),'.directory-group-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const bots=new BotInstanceStore({projectId:'p',path:join(root,'bots.json')})
  const bot=bots.create('qq','Support',{enabled:false})
  const discovery=new ServiceDiscoveryStore('p',join(root,'observations.json'))
  discovery.observe({botInstanceId:bot.id,platform:'qq',conversationId:'group:1',name:'Group'}, {id:'m',sender:'sender',text:'not authority'})
  const deployments=new BotDeployments({directory:join(root,'deployments'),projectId:'p',runGit:async()=>{throw new Error('unavailable')}})
  const runtime=new DirectoryBots(deployments),app=new Hono()
  serviceGroupsPlugin({bots,discovery,runtime,authorize:req=>req.headers.get('x-owner')==='yes'})(app)
  assert.equal((await app.request('/api/service-groups')).status,401)
  const get=async(query='')=>(await(await app.request('/api/service-groups'+query,{headers:{'x-owner':'yes'}})).json())
  assert.equal((await get()).groups[0].enabled,false)
  const files={'BOT.md':'---\nid: support\nconfig: bot.json\n---\nSupport','bot.json':JSON.stringify({mode:'service',allowedModules:[],tools:[],bindings:[{platform:'qq',botInstanceId:bot.id,conversationId:'group:1',tools:[]}]})}
  await deployments.deploy({id:'support',source:{folderId:'folder',directory:''},...deployments.freeze(files)})
  const groups=(await get()).groups
  assert.equal(groups[0].enabled,true);assert.equal(groups[0].agent,'support');assert.deepEqual(groups[0].messages,[])
  assert.equal((await get('?session='+encodeURIComponent(groups[0].sessionId))).groups[0].messages[0].text,'not authority')
  assert.equal((await app.request('/api/service-groups/propose',{method:'POST',headers:{'x-owner':'yes'}})).status,404)
})

test('discovery invalidates real observations but never reads, flush or identical observations', t => {
  const root=mkdtempSync(join(process.cwd(),'.directory-group-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  let changes=0, now=1000
  const discovery=new ServiceDiscoveryStore('p',join(root,'observations.json'),()=>now,()=>{changes++})
  const group={botInstanceId:'bot',platform:'qq' as const,conversationId:'group:1'}
  discovery.observe(group)
  assert.equal(changes,1)
  discovery.list();discovery.flush();discovery.observe(group)
  assert.equal(changes,1)
  discovery.observe(group,{id:'m',sender:'s',text:'hello'})
  assert.equal(changes,2)
  discovery.observe(group,{id:'m',sender:'s',text:'hello'})
  assert.equal(changes,2)
  now++
  discovery.observe({...group,name:'Name'})
  assert.equal(changes,3)
})

test('connection configuration changes invalidate groups only after real persisted changes', t => {
  const root=mkdtempSync(join(process.cwd(),'.directory-group-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  let changes=0
  const bots=new BotInstanceStore({projectId:'p',path:join(root,'bots.json'),changed:()=>{changes++}})
  assert.equal(changes,0)
  const bot=bots.create('qq','Support',{enabled:false})
  assert.equal(changes,1)
  bots.list();bots.status(bot.id)
  bots.update(bot.id,{})
  assert.equal(changes,1)
  bots.update(bot.id,{displayName:'Renamed'})
  assert.equal(changes,2)
  assert.throws(()=>bots.update('absent',{}))
  assert.equal(changes,2)
  bots.delete(bot.id)
  assert.equal(changes,3)
})
