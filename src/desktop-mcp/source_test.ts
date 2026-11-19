import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { managedDesktopSource } from './service.ts'
import { verifyAgentDesktopAssets, agentDesktopTarget, agentDesktopHash, AGENT_DESKTOP_REPOSITORY, AGENT_DESKTOP_REVISION, AGENT_DESKTOP_VERSION } from '../../scripts/agent-desktop-integrity.ts'

// Executable fixture only, never a desktop action. Windows process/protocol tests
// use process.execPath fixtures elsewhere; native .exe asset resolution needs CI.
test('real managed source → importer → invoke_tool: lazy discovery, fixed startup, full schema, connection reuse, role checks and reload protection', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-managed-desktop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = agentDesktopTarget(process.platform, process.arch)
  const directory = join(root, 'integrations/agent-desktop/artifacts', `${process.platform}-${process.arch}`)
  await mkdir(directory, { recursive: true })
  const script = `#!/usr/bin/env node
const r=require('node:readline').createInterface({input:process.stdin});
const reply=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
r.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fake-official',version:'1.2.0'}});
if(m.method==='tools/list')reply(m.id,{tools:[{name:'desktop_snapshot',description:'official fake',inputSchema:{type:'object',properties:{scope:{type:'string',enum:['synthetic']}},required:['scope'],additionalProperties:false}}]});
if(m.method==='tools/call')reply(m.id,{content:[{type:'text',text:'synthetic complete'}],structuredContent:{original:true}});
});`
  const files: Record<string, string> = {}
  for (const [i, file] of target.files.entries()) {
    const bytes = Buffer.from(i === 0 ? script : 'inert required helper; never executed')
    await writeFile(join(directory, file), bytes, { mode: 0o755 })
    files[file] = agentDesktopHash(bytes)
  }
  await writeFile(join(directory, 'manifest.integrity.json'), JSON.stringify({ schema: 1,
    repository: AGENT_DESKTOP_REPOSITORY, version: AGENT_DESKTOP_VERSION, revision: AGENT_DESKTOP_REVISION,
    platform: process.platform, arch: process.arch, archive: { name: target.name, sha256: target.sha256 }, files }))
  const source = managedDesktopSource('p', root, () => {}, true, root, (root) => verifyAgentDesktopAssets(root, process.platform, process.arch, files))
  const importer = new ImportTool(new Map([['agent-desktop', source]]), root, 'p')
  const base = new Tools(root)
  base.register(new InvokeTool(importer))
  base.register({ name: 'read', description: 'inert metadata fixture', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  const tools = new SessionTools(base, root)
  tools.setExecutionScope('session', [])
  const context = { projectId: 'p', sessionId: 'web:managed-fixture', channel: 'web', tools, signal: new AbortController().signal } as ExecutionContext
  t.after(() => tools.resetDynamicAndWait())
  await importer.virtualEntries(context)
  assert.equal(tools.getMcpConn('agent-desktop'), undefined)
  await assert.rejects(importer.updateMcpServers([{ name: 'agent-desktop', transport: 'stdio', command: '/untrusted/command', env: { AGENT_DESKTOP_HOME: '/untrusted' } }]), /reserved/)
  const initialized = await new InvokeTool(importer).execute({ source: 'agent-desktop', args: {} }, context)
  assert.match(String(initialized), /Initialized MCP source agent-desktop/)
  assert.match(String(initialized), /desktop_snapshot/)
  const cached = tools.getMcpConn('agent-desktop')
  assert.ok(cached)
  assert.equal(cached.conn.config.command, join(directory, 'agent-desktop'))
  assert.deepEqual(cached.conn.config.args?.slice(-1), ['mcp'])
  const result = await new InvokeTool(importer).execute({ name: 'agent-desktop__desktop_snapshot', args: { scope: 'synthetic' } }, context)
  assert.match(JSON.stringify(result), /synthetic complete/)
  assert.match(JSON.stringify(result), /original/)
  await new InvokeTool(importer).execute({ source: 'agent-desktop', args: {} }, context)
  assert.equal(tools.getMcpConn('agent-desktop')?.conn, cached.conn)
  await importer.updateMcpServers([])
  assert.equal(tools.getMcpConn('agent-desktop')?.conn, cached.conn)
  const denied = new SessionTools(base, root, ['read'])
  denied.setExecutionScope('session', [])
  const deniedResult = await new InvokeTool(importer).execute({ source: 'agent-desktop', args: {} }, { ...context, tools: denied })
  assert.match(String(deniedResult), /role|agent type/)
  assert.equal(denied.getMcpConn('agent-desktop'), undefined)
})
