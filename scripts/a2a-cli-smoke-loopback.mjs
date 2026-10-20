// Zero-cost real CLI smoke test. No operator environment/auth is inherited.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const prefix = process.argv[2];
if (!prefix) throw Error('Usage: node scripts/a2a-cli-smoke-loopback.mjs <absolute npm prefix>');
const root = await mkdtemp(join(tmpdir(), 'shadow-cli-smoke-'));
const home=join(root,'home'), cwd=join(root,'work');
await mkdir(home); await mkdir(cwd); await mkdir(join(home,'codex')); await mkdir(join(home,'claude'));
const env={SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, PATH:process.env.PATH, TEMP:root,TMP:root, HOME:home,USERPROFILE:home,APPDATA:join(home,'appdata'),LOCALAPPDATA:join(home,'local'),CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY:'1',NO_PROXY:'127.0.0.1,localhost',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'};
const requests=[]; let serial=0;
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req){body+=chunk;if(body.length>2e6){res.writeHead(413).end();return;}}if(requests.length>=12){res.writeHead(429).end();return;}let data;try{data=JSON.parse(body||'{}')}catch{res.writeHead(400).end();return;}
requests.push({path:req.url,model:data.model,stream:data.stream,messages: data.messages?.length,input:data.input?.length});
if(!req.url.startsWith('/v1/responses')&&!req.url.startsWith('/v1/messages')){res.writeHead(404).end('{}');return;}
res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const send=(type,payload)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
const text='LOOPBACK_OK', id=`smoke_${++serial}`;
if(req.url.startsWith('/v1/responses')){const item={id:'msg_'+id,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:data.model,output:[]};send('response.created',{response});send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});send('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:text});send('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text});send('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});}
else{send('message_start',{message:{id,type:'message',role:'assistant',model:data.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});send('content_block_start',{index:0,content_block:{type:'text',text:''}});send('content_block_delta',{index:0,delta:{type:'text_delta',text}});send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});send('message_stop',{});}res.end();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/v1`;
env.ANTHROPIC_BASE_URL=base.slice(0,-3);env.ANTHROPIC_AUTH_TOKEN='synthetic-local-only';env.ANTHROPIC_API_KEY='synthetic-local-only';env.OPENAI_API_KEY='synthetic-local-only';
const codex=join(resolve(prefix),'node_modules/@openai/codex/bin/codex.js');
const claude=join(resolve(prefix),'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const results=[];
async function run(name,file,args,prompt=''){const start=Date.now();const child=spawn(file,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',err='';let timedOut=false;const timer=setTimeout(()=>{timedOut=true; if(process.platform==='win32')spawn(join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F']);else child.kill('SIGKILL');},35000);child.stdout.on('data',b=>{out+=b;if(out.length>1e6)child.kill()});child.stderr.on('data',b=>{err+=b;if(err.length>1e6)child.kill()});child.stdin.on('error',()=>{});child.stdin.end(prompt);const code=await new Promise(r=>{child.on('error',e=>{err+=e.message;r(-1)});child.on('close',r)});clearTimeout(timer);const result={name,code,timedOut,ms:Date.now()-start,out,err};results.push(result);return result;}
try{
await run('codex-version',process.execPath,[codex,'--version']);await run('claude-version',claude,['--version']);await run('codex-help',process.execPath,[codex,'exec','resume','--help']);await run('claude-help',claude,['--help']);
await writeFile(join(home,'codex/config.toml'),`model_provider = "smoke"\nmodel = "smoke-model"\n[model_providers.smoke]\nname = "Loopback"\nbase_url = "${base}"\nwire_api = "responses"\n`);
const c=['-c','approval_policy="never"','-c','sandbox_mode="read-only"','-c','sandbox_workspace_write.network_access=false','-c','web_search="disabled"','exec'];
const first=await run('codex-first',process.execPath,[codex,...c,'--skip-git-repo-check','--json','-'],'Return fixed test text.');let thread;for(const line of first.out.split('\n')){try{const x=JSON.parse(line);if(x.type==='thread.started')thread=x.thread_id;}catch{}}if(thread)await run('codex-resume',process.execPath,[codex,...c,'resume','--skip-git-repo-check','--json',thread,'-'],'Second test turn.');
const a=['--restricted','--print','--output-format','json','--setting-sources','','--settings','{"disableAllHooks":true}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--permission-mode','dontAsk','--tools','','--model','claude-sonnet-4-6'];const sid=randomUUID();const firstA=await run('claude-production-flags',claude,[...a,'--session-id',sid],'Return fixed test text.');if(firstA.code===0)await run('claude-resume',claude,[...a,'--resume',sid],'Second test turn.');
for(const r of results) assert.equal(r.code,0,`${r.name}: ${r.err}`);
assert.equal(requests.length,4,'exactly two requests per provider');
const turns=results.filter(r=>['codex-first','codex-resume'].includes(r.name));assert.equal(turns.length,2);const threads=[];for(const r of turns){const e=r.out.trim().split(/\r?\n/).map(x=>JSON.parse(x));threads.push(e.find(x=>x.type==='thread.started')?.thread_id);assert(e.some(x=>x.type==='turn.completed'));assert(e.some(x=>x.type==='item.completed'&&x.item?.type==='agent_message'&&x.item.text==='LOOPBACK_OK'));}assert.equal(threads[0],threads[1]);
const aturns=results.filter(r=>['claude-production-flags','claude-resume'].includes(r.name));assert.equal(aturns.length,2);for(const r of aturns){const v=JSON.parse(r.out);assert.equal(v.result,'LOOPBACK_OK');assert.equal(v.type,'result');assert.equal(v.subtype,'success');assert.equal(v.is_error,false);assert.equal(v.session_id,sid);assert.equal(v.permission_denials.length,0);}
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(join(root,'results.json'),JSON.stringify({root,requests,results},null,2));console.log(JSON.stringify({root,requests,results:results.map(({out,err,...r})=>({...r,out:out.slice(0,2500),err:err.slice(0,1500)}))},null,2));}
