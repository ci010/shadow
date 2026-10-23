import assert from 'node:assert/strict'
import test from 'node:test'
import { open, mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { copyUserProfile } from './profile-copy.ts'

async function fixture(home: string) {
  const userDataDir = join(home, 'source'), profileDirectory = 'Profile 2'
  await mkdir(join(userDataDir, profileDirectory, 'Network'), { recursive: true })
  for (const name of ['Network/Cookies', 'Network/Other', 'Preferences', 'History']) await writeFile(join(userDataDir, profileDirectory, name), 'synthetic')
  await writeFile(join(userDataDir, 'Local State'), 'synthetic')
  return { userDataDir, profileDirectory }
}
const busy: typeof open = async () => { throw Object.assign(new Error('PRIVATE CONTENT'), { code: 'EBUSY' }) }
test('EBUSY Cookies does not stop Network siblings; selected profile allowlist omits history, cache and locks', async () => withTempWorkspace(async home => {
  const source = await fixture(home), destination = join(home, 'copy')
  await mkdir(join(source.userDataDir, source.profileDirectory, 'Network', 'Cache'))
  await writeFile(join(source.userDataDir, source.profileDirectory, 'Network', 'LOCK'), 'lock')
  const report = await copyUserProfile(source, destination, undefined, { open: async (path, flags, mode) => String(path).endsWith('Cookies') ? busy(path, flags, mode) : open(path, flags, mode) })
  assert.equal(report.status, 'ready_with_warnings')
  assert.ok(report.warnings.some(w => w.item === 'Profile 2/Network/Cookies' && w.stage === 'open-source' && w.osCode === 'EBUSY'))
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE CONTENT/)
  assert.deepEqual(await readdir(join(destination, source.profileDirectory, 'Network')), ['Other'])
  assert.deepEqual((await readdir(join(destination, source.profileDirectory))).sort(), ['Network', 'Preferences'])
  assert.equal(await readFile(join(source.userDataDir, source.profileDirectory, 'Network', 'Cookies'), 'utf8'), 'synthetic')
}))
test('all source reads fail: usable copy, explicit no login migration; optional absences are not warnings', async () => withTempWorkspace(async home => {
  const source = await fixture(home)
  const report = await copyUserProfile(source, join(home, 'copy'), undefined, { open: busy })
  assert.equal(report.copiedFiles, 0)
  assert.equal(report.loginData, 'not_migrated')
  assert.match(report.message, /No login data was migrated/)
  assert.ok(report.warnings.some(w => w.item === 'Local State' && w.osCode === 'EBUSY'))
  assert.ok(report.absent.includes('Profile 2/Login Data'))
  assert.equal(report.warnings.filter(w => w.osCode === 'ENOENT').length, 0)
}))
test('destination permission errors are fatal, not source warnings; cleanup preserves existing destinations', async () => withTempWorkspace(async home => {
  const source = await fixture(home), destination = join(home, 'copy')
  await assert.rejects(copyUserProfile(source, destination, undefined, { open: async (path, flags, mode) => {
    if (flags === 'wx') throw Object.assign(new Error('secret'), { code: 'EACCES' })
    return open(path, flags, mode)
  } }), /stage=open-destination.*osCode=EACCES/)
  assert.deepEqual(await readdir(home), ['source'])
  await mkdir(destination); await writeFile(join(destination, 'keep'), 'keep')
  await assert.rejects(copyUserProfile(source, destination), /stage=create-destination.*EEXIST/)
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'keep')
}))
test('cancellation removes partial destination; invalid roots and destination boundaries remain fatal', async () => withTempWorkspace(async home => {
  const source = await fixture(home), controller = new AbortController()
  await assert.rejects(copyUserProfile(source, join(home, 'copy'), controller.signal, { open: async (path, flags, mode) => { controller.abort(); return open(path, flags, mode) } }), /abort/i)
  assert.deepEqual(await readdir(home), ['source'])
  await assert.rejects(copyUserProfile(source, join(source.userDataDir, 'copy')), /DESTINATION_INSIDE_SOURCE/)
  await assert.rejects(copyUserProfile({ ...source, userDataDir: join(home, 'missing') }, join(home, 'copy')), /validate-source.*ENOENT/)
  await symlink(source.userDataDir, join(home, 'linked'), 'junction')
  await assert.rejects(copyUserProfile({ ...source, userDataDir: join(home, 'linked') }, join(home, 'copy')), /UNSUPPORTED_SOURCE/)
}))

test('detected source mutation is a per-item warning and discards inconsistent file', async () => withTempWorkspace(async home => {
  const source = await fixture(home), destination = join(home, 'copy')
  const report = await copyUserProfile(source, destination, undefined, { open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    if (flags === 'r' && String(path).endsWith('Preferences')) await writeFile(path, 'changed synthetic data')
    return handle
  } })
  assert.ok(report.warnings.some(w => w.code === 'SOURCE_CHANGED' && w.item === 'Profile 2/Preferences'))
  await assert.rejects(readFile(join(destination, source.profileDirectory, 'Preferences')), { code: 'ENOENT' })
  assert.equal(await readFile(join(destination, 'Local State'), 'utf8'), 'synthetic')
}))
