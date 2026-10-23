import assert from 'node:assert/strict'
import test from 'node:test'
import { managedBrowserInstallations, managedBrowserNames, validateManagedBrowser } from './managed-browsers.ts'

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: reviewed browser/channel pairs validate without reading user data or executing`, async () => {
    const entries = managedBrowserInstallations(platform, { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', XDG_CONFIG_HOME: '/fixture/config' }, '/fixture')
    assert.deepEqual([...new Set(entries.map(item => item.browser))].sort(), [...managedBrowserNames].sort())
    // Synthetic resolver: no actual installations or personal profiles inspected.
    const resolve = async (path: string) => {
      if (!entries.some(item => item.executable === path || item.userDataDir === path)) throw new Error('absent fixture')
      return path
    }
    for (const entry of entries) {
      await validateManagedBrowser(entry.executable, entry.browser, entry.userDataDir, entries, resolve)
      const other = entries.find(item => item.browser !== entry.browser)!
      await assert.rejects(validateManagedBrowser(entry.executable, other.browser, entry.userDataDir, entries, resolve), /recognized installation/)
      await assert.rejects(validateManagedBrowser(entry.executable, entry.browser, other.userDataDir, entries, resolve), /matching browser\/channel/)
      const channel = entries.find(item => item.browser === entry.browser && item.channel !== entry.channel)
      if (channel) await assert.rejects(validateManagedBrowser(entry.executable, entry.browser, channel.userDataDir, entries, resolve), /matching browser\/channel/)
    }
    await assert.rejects(validateManagedBrowser('/custom/chrome.exe', 'chrome', entries[0].userDataDir, entries, async p => p), /recognized installation/)
    await assert.rejects(validateManagedBrowser(entries[0].executable, entries[0].browser, '/custom/root', entries, async p => p), /recognized installation/)
  })
}

test('unknown platforms fail closed; Linux honors only absolute XDG config paths', () => {
  assert.deepEqual(managedBrowserInstallations('unknown', {}, '/fixture'), [])
  assert.ok(managedBrowserInstallations('linux', { XDG_CONFIG_HOME: 'relative' }, '/fixture').every(item => item.userDataDir.startsWith('/fixture/.config/')))
})

test('canonical package links are supported, absent entries and lookalike basenames are not', async () => {
  const entries = [{ browser: 'edge' as const, channel: 'stable', executable: '/usr/bin/microsoft-edge', userDataDir: '/fixture/.config/microsoft-edge' }]
  const resolve = async (path: string) => path === '/usr/bin/microsoft-edge' ? '/opt/microsoft/msedge/msedge' : path
  await validateManagedBrowser('/opt/microsoft/msedge/msedge', 'edge', entries[0].userDataDir, entries, resolve)
  await assert.rejects(validateManagedBrowser('/tmp/msedge', 'edge', entries[0].userDataDir, entries, resolve), /recognized installation/)
})
