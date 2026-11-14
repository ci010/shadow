import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { BotDeployments } from '../src/bots/deployments.ts'

const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-connections.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 })
test('CLI operates only explicit synthetic Projects; plan is read-only and apply/restore never print credentials', async () => {
  await withTempWorkspace(async home => {
    const projectId = 'synthetic-cli', deployments = join(home, 'deployments')
    new BotDeployments({ projectId, directory: deployments })
    const connections = join(home, 'connections.json'), manifest = join(home, 'manifest.json')
    const original = JSON.stringify({ version: 2, bots: [{ id: 'unbound', projectId, platform: 'qq', displayName: 'Unbound', purpose: 'service', config: { enabled: false, appId: 'PRIVATE_APP', secret: 'PRIVATE_SECRET', allowFrom: ['owner'] } }] })
    writeFileSync(connections, original)
    writeFileSync(manifest, JSON.stringify({ version: 1, projects: [{ projectId, home, connections, deployments, sources: [] }] }))
    assert.equal(run('plan', manifest).status, 1, 'No unstated offline assertion')
    const plan = run('plan', manifest, '--runtime-stopped')
    assert.equal(plan.status, 0, plan.stderr); assert.equal(existsSync(join(home, '.connection-policy-migration')), false)
    const apply = run('apply', manifest, '--runtime-stopped')
    assert.equal(apply.status, 0, apply.stderr); assert.equal(JSON.parse(readFileSync(connections, 'utf8')).version, 3)
    const restore = run('restore', manifest, '--runtime-stopped')
    assert.equal(restore.status, 0, restore.stderr); assert.equal(readFileSync(connections, 'utf8'), original)
    assert.doesNotMatch(plan.stdout + apply.stdout + restore.stdout + plan.stderr + apply.stderr + restore.stderr, /PRIVATE_/)
  })
})
test('CLI malformed secret-bearing input is sanitized, not returned in JSON parse errors', async () => {
  await withTempWorkspace(async home => {
    const manifest = join(home, 'bad.json'); writeFileSync(manifest, 'PRIVATE_SECRET is not JSON')
    const result = run('plan', manifest, '--runtime-stopped')
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SECRET/)
  })
})
