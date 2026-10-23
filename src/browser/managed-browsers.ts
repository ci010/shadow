import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export const managedBrowserNames = ['chrome', 'edge', 'brave', 'chromium'] as const
export type ManagedBrowserName = typeof managedBrowserNames[number]
export interface BrowserInstallation { browser: ManagedBrowserName; channel: string; executable: string; userDataDir: string }

/** Reviewed installation/profile pairs, not a basename or arbitrary executable allowlist.
 * Adding a browser requires reviewing its launch flags and profile-copy compatibility.
 * Discovery probes these reviewed paths and minimal profile labels only. Custom layouts use attach.
 */
export function managedBrowserInstallations(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): BrowserInstallation[] {
  const result: BrowserInstallation[] = []
  const path = platform === 'win32' ? win32 : posix
  const add = (browser: ManagedBrowserName, channel: string, executable: string, userDataDir: string) => result.push({ browser, channel, executable, userDataDir })
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (!local) return result
    const entries: [ManagedBrowserName, string, string, string, string][] = [
      ['chrome', 'stable', 'Google/Chrome', 'chrome.exe', 'Google/Chrome/User Data'],
      ['chrome', 'beta', 'Google/Chrome Beta', 'chrome.exe', 'Google/Chrome Beta/User Data'],
      ['chrome', 'dev', 'Google/Chrome Dev', 'chrome.exe', 'Google/Chrome Dev/User Data'],
      ['chrome', 'canary', 'Google/Chrome SxS', 'chrome.exe', 'Google/Chrome SxS/User Data'],
      ['edge', 'stable', 'Microsoft/Edge', 'msedge.exe', 'Microsoft/Edge/User Data'],
      ['edge', 'beta', 'Microsoft/Edge Beta', 'msedge.exe', 'Microsoft/Edge Beta/User Data'],
      ['edge', 'dev', 'Microsoft/Edge Dev', 'msedge.exe', 'Microsoft/Edge Dev/User Data'],
      ['edge', 'canary', 'Microsoft/Edge SxS', 'msedge.exe', 'Microsoft/Edge SxS/User Data'],
      ['brave', 'stable', 'BraveSoftware/Brave-Browser', 'brave.exe', 'BraveSoftware/Brave-Browser/User Data'],
      ['brave', 'beta', 'BraveSoftware/Brave-Browser-Beta', 'brave.exe', 'BraveSoftware/Brave-Browser-Beta/User Data'],
      ['brave', 'nightly', 'BraveSoftware/Brave-Browser-Nightly', 'brave.exe', 'BraveSoftware/Brave-Browser-Nightly/User Data'],
      ['chromium', 'stable', 'Chromium', 'chrome.exe', 'Chromium/User Data'],
    ]
    for (const root of new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], local].filter((p): p is string => !!p))) {
      for (const [browser, channel, app, exe, data] of entries) add(browser, channel, path.join(root, app, 'Application', exe), path.join(local, data))
    }
  } else if (platform === 'darwin') {
    const entries: [ManagedBrowserName, string, string, string][] = [
      ['chrome', 'stable', 'Google Chrome', 'Google/Chrome'], ['chrome', 'beta', 'Google Chrome Beta', 'Google/Chrome Beta'],
      ['chrome', 'dev', 'Google Chrome Dev', 'Google/Chrome Dev'], ['chrome', 'canary', 'Google Chrome Canary', 'Google/Chrome Canary'],
      ['edge', 'stable', 'Microsoft Edge', 'Microsoft Edge'], ['edge', 'beta', 'Microsoft Edge Beta', 'Microsoft Edge Beta'],
      ['edge', 'dev', 'Microsoft Edge Dev', 'Microsoft Edge Dev'], ['edge', 'canary', 'Microsoft Edge Canary', 'Microsoft Edge Canary'],
      ['brave', 'stable', 'Brave Browser', 'BraveSoftware/Brave-Browser'], ['brave', 'beta', 'Brave Browser Beta', 'BraveSoftware/Brave-Browser-Beta'],
      ['brave', 'nightly', 'Brave Browser Nightly', 'BraveSoftware/Brave-Browser-Nightly'], ['chromium', 'stable', 'Chromium', 'Chromium'],
    ]
    for (const root of ['/Applications', path.join(home, 'Applications')]) for (const [browser, channel, app, data] of entries) {
      add(browser, channel, path.join(root, `${app}.app`, 'Contents', 'MacOS', app), path.join(home, 'Library/Application Support', data))
    }
  } else if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config')
    const entries: [ManagedBrowserName, string, string[], string][] = [
      ['chrome', 'stable', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'], 'google-chrome'],
      ['chrome', 'beta', ['/usr/bin/google-chrome-beta', '/opt/google/chrome-beta/chrome'], 'google-chrome-beta'],
      ['chrome', 'dev', ['/usr/bin/google-chrome-unstable', '/opt/google/chrome-unstable/chrome'], 'google-chrome-unstable'],
      ['edge', 'stable', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'], 'microsoft-edge'],
      ['edge', 'beta', ['/usr/bin/microsoft-edge-beta', '/opt/microsoft/msedge-beta/msedge'], 'microsoft-edge-beta'],
      ['edge', 'dev', ['/usr/bin/microsoft-edge-dev', '/opt/microsoft/msedge-dev/msedge'], 'microsoft-edge-dev'],
      ['brave', 'stable', ['/usr/bin/brave-browser', '/usr/bin/brave-browser-stable', '/opt/brave.com/brave/brave-browser'], 'BraveSoftware/Brave-Browser'],
      ['brave', 'beta', ['/usr/bin/brave-browser-beta', '/opt/brave.com/brave-beta/brave-browser'], 'BraveSoftware/Brave-Browser-Beta'],
      ['brave', 'nightly', ['/usr/bin/brave-browser-nightly', '/opt/brave.com/brave-nightly/brave-browser'], 'BraveSoftware/Brave-Browser-Nightly'],
      ['chromium', 'stable', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium'], 'chromium'],
    ]
    for (const [browser, channel, executables, data] of entries) for (const executable of executables) add(browser, channel, executable, path.join(config, data))
  }
  return result
}

/** realpath equality retains the prior recognized-installation security boundary.
 * It is not binary attestation: host installation integrity remains an OS concern.
 * Resolve both sides to support packaged symlinks, but never accept just a name.
 */
export async function validateManagedBrowser(executable: string, browser: ManagedBrowserName, userDataDir: string,
  installations = managedBrowserInstallations(), resolve: (path: string) => Promise<string> = realpath): Promise<void> {
  let selected: string, source: string
  try { [selected, source] = await Promise.all([resolve(executable), resolve(userDataDir)]) }
  catch { throw new Error('Chosen managed browser installation or source root is unavailable.') }
  for (const candidate of installations.filter(item => item.browser === browser)) {
    try {
      if (await resolve(candidate.executable) === selected && await resolve(candidate.userDataDir) === source) return
    } catch { /* absent installation or profile */ }
  }
  throw new Error('Managed launch requires a recognized installation and its matching browser/channel source root. Chrome, Edge, Brave and Chromium standard layouts are supported; custom executables, custom profile roots and other CDP apps require explicitly approved attach. No profile was copied or browser launched.')
}

export interface DiscoveredBrowser extends BrowserInstallation {
  id: string
  profiles: { directory: string; displayName: string }[]
  profileStatus: 'available' | 'unavailable' | 'no-profiles'
}

/** Read-only inventory; never reads Preferences, cookies, history or credentials.
 * Local State is parsed only for profile.info_cache[*].name, bounded in size;
 * no account metadata is returned, and email-like labels are redacted.
 */
export async function discoverManagedBrowsers(installations = managedBrowserInstallations()): Promise<DiscoveredBrowser[]> {
  const found: DiscoveredBrowser[] = []
  const seen = new Set<string>()
  for (const candidate of installations) {
    try { if (!(await stat(candidate.executable)).isFile()) continue } catch { continue }
    const key = `${candidate.browser}:${candidate.channel}:${candidate.userDataDir}`
    // Standard aliases/install roots for the same brand/channel/profile root are equivalent.
    if (seen.has(key)) continue
    seen.add(key)
    const entry: DiscoveredBrowser = { ...candidate, id: `${candidate.browser}:${candidate.channel}`, profiles: [], profileStatus: 'unavailable' }
    found.push(entry)
    try {
      const root = await lstat(candidate.userDataDir)
      if (!root.isDirectory() || root.isSymbolicLink()) continue
      const names = (await readdir(candidate.userDataDir)).filter(n => /^(Default|Profile [0-9]+)$/.test(n)).sort()
      let labels: Record<string, { name?: unknown }> = {}
      try {
        const statePath = join(candidate.userDataDir, 'Local State')
        const info = await lstat(statePath)
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024) {
          labels = JSON.parse(await readFile(statePath, 'utf8'))?.profile?.info_cache ?? {}
        }
      } catch { /* labels optional; directory identifiers remain usable */ }
      for (const directory of names) {
        const info = await lstat(join(candidate.userDataDir, directory))
        if (!info.isDirectory() || info.isSymbolicLink()) continue
        const label = labels?.[directory]?.name
        const displayName = typeof label === 'string' && label.trim() && !label.includes('@')
          ? label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : directory
        entry.profiles.push({ directory, displayName })
      }
      entry.profileStatus = entry.profiles.length ? 'available' : 'no-profiles'
    } catch { /* installed browser still reported, with unavailable source */ }
  }
  return found
}

export function selectManagedBrowser(inventory: DiscoveredBrowser[], selection: { browser?: ManagedBrowserName; installation?: string; profile?: string; profileDirectory?: string }) {
  let candidates = inventory.filter(item => (!selection.browser || item.browser === selection.browser) && (!selection.installation || item.id === selection.installation))
  if (candidates.length !== 1) throw new Error(candidates.length ? 'AMBIGUOUS_BROWSER: select a discovered installation ID; do not ask for paths.' : 'BROWSER_NOT_FOUND: inspect discover; custom installations require explicit attach.')
  const candidate = candidates[0]
  const name = selection.profileDirectory ?? selection.profile
  const profiles = candidate.profiles.filter(item => !name || item.directory.toLowerCase() === name.toLowerCase() || (!selection.profileDirectory && item.displayName.toLowerCase() === name.toLowerCase()))
  if (profiles.length !== 1) throw new Error(profiles.length ? 'AMBIGUOUS_PROFILE: ask which discovered profile name to use.' : 'PROFILE_NOT_FOUND: inspect discovered profile candidates; a valid selected source profile is required.')
  return { browser: candidate.browser, executablePath: candidate.executable, userDataDir: candidate.userDataDir, profileDirectory: profiles[0].directory }
}
