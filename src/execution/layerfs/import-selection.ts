/** Self-contained for the fixed WSL staging helper. Git reads names/index only. */
export async function importSelection(root: string, sourcePlatform: string = process.platform): Promise<{ includes: (path: string) => boolean; git: boolean }> {
  const fs = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { join, resolve } = await import('node:path')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const run = async (args: string[]) => (await promisify(execFile)('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env,
  })).stdout
  let git = false
  try {
    const s = await fs.lstat(join(root, '.git'))
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsupported external Git metadata topology')
    git = true
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const selected = new Set<string>()
  if (git) {
    if (resolve((await run(['rev-parse', '--show-toplevel'])).trim()) !== resolve(root)) throw new Error('Import requires a repository root')
    const config = await run(['config', '--local', '--null', '--list'])
    if (/(?:^|\0)core\.worktree\n/i.test(config)) throw new Error('Unsupported external Git worktree configuration')
    for (const p of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
      try { await fs.lstat(join(root, '.git', p)); throw new Error('Unsupported external Git metadata topology') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    // A gitlink names only the submodule directory, never its working tree.
    // Refuse before selection so neither an initialized .git pointer nor the
    // submodule contents can be silently filtered into an empty directory.
    const staged = (await run(['ls-files', '--stage', '-z'])).split('\0')
    if (staged.some(record => record.startsWith('160000 '))) throw new Error('unsupported_git_submodule_topology')
    const inventory = (await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    if (sourcePlatform === 'linux') inventory.push(...(await run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(p => p.split('/').includes('node_modules')))
    for (const p of inventory) {
      if (p.endsWith('/')) throw new Error('Unsupported embedded repository topology')
      if (p.startsWith('/') || p.split('/').some(v => v === '..' || v === '.') || p.includes('\\')) throw new Error('Unsafe Git path')
      const parts = p.split('/')
      for (let i = 1; i <= parts.length; i++) selected.add(parts.slice(0, i).join('/'))
    }
  }
  return { git, includes: (p: string) => {
    // Source provenance is supplied explicitly by the Windows -> WSL helper;
    // never infer Windows source OS from the Linux staging process.
    if (p === '.git' || p.startsWith('.git/')) return true
    if (p.split('/').includes('node_modules')) return sourcePlatform === 'linux'
    return !git || selected.has(p)
  } }
}
