import { resolve } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { readdir, readFile, stat as nodeStat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { env } from 'node:process'
import { getOs, isWindows } from './runtime.ts'

/** Run a command to completion and capture stdout/stderr/exit code. */
async function runCommand(
  command: string,
  args: string[],
  opts: { stdoutMode?: 'pipe' | 'ignore' } = {},
): Promise<{ success: boolean; code: number; stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolve, reject) => {
    const proc = childSpawn(command, args, {
      stdio: ['ignore', opts.stdoutMode ?? 'pipe', 'pipe'],
    })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    proc.stdout?.on('data', (c: Buffer) => outChunks.push(c))
    proc.stderr?.on('data', (c: Buffer) => errChunks.push(c))
    proc.once('error', reject)
    proc.once('close', (code) => {
      resolve({
        success: code === 0,
        code: code ?? -1,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
      })
    })
  })
}

/**
 * Check whether ripgrep (`rg`) is available in PATH.
 * Returns true if `rg --version` exits successfully.
 */
export async function detectRipgrep(): Promise<boolean> {
  try {
    const output = await runCommand('rg', ['--version'], { stdoutMode: 'ignore' })
    return output.success
  } catch {
    return false
  }
}

/** Singleton install promise — prevents concurrent installs and allows background completion. */
let installPromise: Promise<{ success: boolean; message: string }> | null = null

/** Timeout for waiting on install before letting the agent proceed (ms). */
const INSTALL_TIMEOUT_MS = 30_000

/**
 * Attempt to install ripgrep automatically based on the current OS.
 * - Singleton: concurrent calls share the same install attempt.
 * - Timeout: if install takes longer than 30s, the caller gets a timeout
 *   result but the install continues in the background. A subsequent
 *   `detectRipgrep()` call will pick up the finished install.
 *
 * @param workspace - Workspace root for persisting PATH additions to .env
 */
export function installRipgrep(workspace?: string): Promise<{ success: boolean; message: string }> {
  if (!installPromise) {
    installPromise = doInstallRipgrep(workspace).finally(() => {
      installPromise = null
    })
  }

  // Race against timeout — install keeps running even if we time out
  return Promise.race([
    installPromise,
    new Promise<{ success: boolean; message: string }>((resolve) =>
      setTimeout(
        () => resolve({
          success: false,
          message: `ripgrep install is still running in the background (timed out after ${INSTALL_TIMEOUT_MS / 1000}s). The search tool will become available once the install finishes.`,
        }),
        INSTALL_TIMEOUT_MS,
      )
    ),
  ])
}

async function doInstallRipgrep(workspace?: string): Promise<{ success: boolean; message: string }> {
  const os = getOs()

  let command: string
  let args: string[]

  switch (os) {
    case 'windows':
      command = 'winget'
      args = ['install', 'BurntSushi.ripgrep.MSVC', '--accept-source-agreements', '--accept-package-agreements']
      break
    case 'darwin':
      command = 'brew'
      args = ['install', 'ripgrep']
      break
    case 'linux':
      command = 'sudo'
      args = ['apt-get', 'install', '-y', 'ripgrep']
      break
    default:
      return { success: false, message: `Unsupported OS "${os}" for auto-install.` }
  }

  try {
    console.info(`[ripgrep] Auto-installing ripgrep via: ${command} ${args.join(' ')}`)
    const output = await runCommand(command, args)
    const stderr = output.stderr.toString('utf8')

    if (!output.success) {
      return {
        success: false,
        message: `Install command failed (exit ${output.code}): ${stderr.slice(0, 500)}`,
      }
    }

    // Verify installation — rg may already be on the current PATH
    if (await detectRipgrep()) {
      console.info('[ripgrep] Auto-install succeeded.')
      return { success: true, message: 'ripgrep installed successfully.' }
    }

    // Install succeeded but rg not on current process PATH.
    // Probe known install locations and patch PATH if found.
    const rgDir = await findRipgrepDir()
    if (rgDir) {
      // Update the current process PATH so rg is immediately usable
      const currentPath = env.PATH ?? ''
      process.env.PATH = `${rgDir}${isWindows ? ';' : ':'}${currentPath}`
      console.info(`[ripgrep] Added ${rgDir} to process PATH.`)

      // Persist PATH addition in workspace .env for future subprocesses
      if (workspace) {
        await appendEnvPath(workspace, rgDir)
      }

      if (await detectRipgrep()) {
        console.info('[ripgrep] Auto-install succeeded (PATH patched).')
        return { success: true, message: 'ripgrep installed successfully.' }
      }
    }

    return {
      success: false,
      message: 'Install command succeeded but rg is still not found in PATH. You may need to restart the shell or add it to PATH manually.',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, message: `Failed to run install command: ${msg}` }
  }
}

/**
 * Probe well-known directories where ripgrep may have been installed.
 * Returns the directory containing the rg binary, or null.
 */
async function findRipgrepDir(): Promise<string | null> {
  const os = getOs()
  const candidates: string[] = []

  if (os === 'windows') {
    const localAppData = env.LOCALAPPDATA
    const userProfile = env.USERPROFILE
    const programFiles = env.ProgramFiles
    if (localAppData) {
      // winget shimlinks
      candidates.push(resolve(localAppData, 'Microsoft', 'WinGet', 'Links'))
      // winget package install dir
      candidates.push(resolve(localAppData, 'Microsoft', 'WinGet', 'Packages'))
    }
    if (userProfile) {
      // scoop
      candidates.push(resolve(userProfile, 'scoop', 'shims'))
    }
    if (programFiles) {
      // choco
      candidates.push(resolve(programFiles, 'ripgrep'))
    }
    // cargo
    if (userProfile) {
      candidates.push(resolve(userProfile, '.cargo', 'bin'))
    }
  } else if (os === 'darwin') {
    candidates.push('/usr/local/bin', '/opt/homebrew/bin')
  } else {
    candidates.push('/usr/bin', '/usr/local/bin')
  }

  const rgName = isWindows ? 'rg.exe' : 'rg'

  for (const dir of candidates) {
    // For WinGet Packages dir, rg.exe may be nested deeper — search one level
    if (dir.endsWith('Packages')) {
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().includes('ripgrep')) {
            const nested = resolve(dir, entry.name)
            const rgPath = await findRgInDir(nested, rgName)
            if (rgPath) return rgPath
          }
        }
      } catch { /* dir may not exist */ }
      continue
    }

    try {
      const stat = await nodeStat(resolve(dir, rgName))
      if (stat.isFile()) return dir
    } catch { /* not here */ }
  }

  return null
}

/** Recursively search for rg binary within a directory (max 2 levels deep). */
async function findRgInDir(dir: string, rgName: string, depth = 0): Promise<string | null> {
  if (depth > 2) return null
  try {
    const stat = await nodeStat(resolve(dir, rgName))
    if (stat.isFile()) return dir
  } catch { /* not at this level */ }

  if (depth < 2) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const result = await findRgInDir(resolve(dir, entry.name), rgName, depth + 1)
          if (result) return result
        }
      }
    } catch { /* can't read dir */ }
  }
  return null
}

/**
 * Append a directory to the PATH variable in the workspace .env file.
 * Creates the file if it doesn't exist. Avoids duplicate entries.
 */
async function appendEnvPath(workspace: string, dir: string): Promise<void> {
  const envPath = resolve(workspace, '.env')
  const sep = isWindows ? ';' : ':'

  try {
    let content = ''
    try {
      content = await readFile(envPath, 'utf8')
    } catch { /* file doesn't exist yet */ }

    // Check if PATH is already defined with this dir
    const pathLine = content.split('\n').find((l) => l.startsWith('PATH='))
    if (pathLine && pathLine.includes(dir)) return // already present

    if (pathLine) {
      // Append to existing PATH line
      const currentValue = pathLine.slice(5) // strip 'PATH='
      const newLine = `PATH=${dir}${sep}${currentValue}`
      content = content.replace(pathLine, newLine)
    } else {
      // Add new PATH line that extends the system PATH
      const systemPath = isWindows ? '%PATH%' : '$PATH'
      const line = `PATH=${dir}${sep}${systemPath}`
      content = content.trimEnd() + (content.trim() ? '\n' : '') + line + '\n'
    }

    await writeFile(envPath, content)
    console.info(`[ripgrep] Persisted PATH addition to ${envPath}`)
  } catch (e) {
    console.warn(`[ripgrep] Failed to update .env: ${e instanceof Error ? e.message : String(e)}`)
  }
}
