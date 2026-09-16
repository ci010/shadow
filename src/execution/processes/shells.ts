import { join } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { stat as nodeStat } from 'node:fs/promises'
import { env } from 'node:process'
import { isWindows } from '../../utils/runtime.ts'

/** Run a command to completion and capture stdout/exit code. */
function runCommand(
  command: string,
  args: string[],
): Promise<{ success: boolean; code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const proc = childSpawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c))
    proc.once('error', () =>
      resolve({ success: false, code: -1, stdout: Buffer.alloc(0) })
    )
    proc.once('close', (code) => {
      resolve({
        success: code === 0,
        code: code ?? -1,
        stdout: Buffer.concat(chunks),
      })
    })
  })
}

export type ManagedShell =
  | 'cmd'
  | 'sh'
  | 'bash'
  | 'git-bash'
  | 'powershell'
  | 'pwsh'

export interface DetectedExecShell {
  name: string
  command: string
  source: 'builtin' | 'path' | 'well-known-path'
  version?: string
  default?: boolean
}

let detectedExecShellsPromise: Promise<DetectedExecShell[]> | null = null

export function defaultManagedShell(): ManagedShell {
  return isWindows ? 'cmd' : 'sh'
}

export async function availableExecShells(): Promise<DetectedExecShell[]> {
  if (!detectedExecShellsPromise) {
    detectedExecShellsPromise = detectExecShells()
  }
  return await detectedExecShellsPromise
}

export async function resolveExecShell(
  name: string,
): Promise<DetectedExecShell | null> {
  const shells = await availableExecShells()
  return shells.find((shell) => shell.name === name) ?? null
}

async function detectExecShells(): Promise<DetectedExecShell[]> {
  return isWindows
    ? await detectWindowsExecShells()
    : await detectPosixExecShells()
}

async function detectWindowsExecShells(): Promise<DetectedExecShell[]> {
  const [cmdShell, powershellShell, pwshShell, gitBashShell, shShell] =
    await Promise.all([
      (async (): Promise<DetectedExecShell> => ({
        name: 'cmd',
        command: 'cmd',
        source: 'builtin',
        version: await detectCmdVersion(),
        default: true,
      }))(),
      (async (): Promise<DetectedExecShell | null> => {
        const powershellPath = await findExecutableOnPath([
          'powershell.exe',
          'powershell',
        ])
        if (!powershellPath) return null
        return {
          name: 'powershell',
          command: powershellPath,
          source: 'path',
          version: await detectPowerShellVersion(powershellPath),
        }
      })(),
      (async (): Promise<DetectedExecShell | null> => {
        const pwshPath = await findExecutableOnPath(['pwsh.exe', 'pwsh'])
        if (!pwshPath) return null
        return {
          name: 'pwsh',
          command: pwshPath,
          source: 'path',
          version: await detectPowerShellVersion(pwshPath),
        }
      })(),
      (async (): Promise<DetectedExecShell | null> => {
        const gitBashPath = await findGitBashExecutable()
        if (!gitBashPath) return null
        return {
          name: 'git-bash',
          command: gitBashPath,
          source: gitBashPath.includes('Git') ? 'well-known-path' : 'path',
          version: await detectBashVersion(gitBashPath),
        }
      })(),
      (async (): Promise<DetectedExecShell | null> => {
        const shPath = await findExecutableOnPath(['sh.exe', 'sh'])
        if (!shPath) return null
        return {
          name: 'sh',
          command: shPath,
          source: 'path',
          version: await detectBashVersion(shPath),
        }
      })(),
    ])

  return [cmdShell, powershellShell, pwshShell, gitBashShell, shShell]
    .filter((shell): shell is DetectedExecShell => Boolean(shell))
    .filter((shell, index, all) =>
      all.findIndex((candidate) => candidate.command === shell.command) ===
        index
    )
}

async function detectPosixExecShells(): Promise<DetectedExecShell[]> {
  const [shShell, bashShell, pwshShell, powershellShell] = await Promise.all([
    Promise.resolve<DetectedExecShell>({
      name: 'sh',
      command: '/bin/sh',
      source: 'builtin',
      default: true,
    }),
    (async (): Promise<DetectedExecShell | null> => {
      const bashPath = await findExecutableOnPath(['bash'])
      if (!bashPath) return null
      return {
        name: 'bash',
        command: bashPath,
        source: 'path',
        version: await detectBashVersion(bashPath),
      }
    })(),
    (async (): Promise<DetectedExecShell | null> => {
      const pwshPath = await findExecutableOnPath(['pwsh'])
      if (!pwshPath) return null
      return {
        name: 'pwsh',
        command: pwshPath,
        source: 'path',
        version: await detectPowerShellVersion(pwshPath),
      }
    })(),
    (async (): Promise<DetectedExecShell | null> => {
      const powershellPath = await findExecutableOnPath(['powershell'])
      if (!powershellPath) return null
      return {
        name: 'powershell',
        command: powershellPath,
        source: 'path',
        version: await detectPowerShellVersion(powershellPath),
      }
    })(),
  ])

  return [shShell, bashShell, pwshShell, powershellShell]
    .filter((shell): shell is DetectedExecShell => Boolean(shell))
    .filter((shell, index, all) =>
      all.findIndex((candidate) => candidate.command === shell.command) ===
        index
    )
}

async function findExecutableOnPath(names: string[]): Promise<string | null> {
  const locator = isWindows ? 'where' : 'which'

  for (const name of names) {
    try {
      const output = await runCommand(locator, [name])
      if (!output.success) continue

      const stdout = output.stdout.toString('utf8').trim()
      const path = stdout.split(/\r?\n/).find(Boolean)
      if (path) return path.trim()
    } catch {
      // Ignore lookup failures and keep probing other names.
    }
  }

  return null
}

async function findGitBashExecutable(): Promise<string | null> {
  const pathCandidate = await findExecutableOnPath(['git-bash.exe', 'git-bash'])
  if (pathCandidate) return pathCandidate

  const envVars = env
  const candidates = [
    envVars.ProgramFiles ? join(envVars.ProgramFiles, 'Git', 'bin', 'bash.exe') : null,
    envVars.ProgramFiles
      ? join(envVars.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe')
      : null,
    envVars['ProgramFiles(x86)']
      ? join(envVars['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : null,
    envVars['ProgramFiles(x86)']
      ? join(envVars['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'bash.exe')
      : null,
    envVars.LOCALAPPDATA
      ? join(envVars.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : null,
    envVars.LOCALAPPDATA
      ? join(envVars.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    try {
      const stat = await nodeStat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // Ignore missing well-known paths.
    }
  }

  return null
}

async function detectCmdVersion(): Promise<string | undefined> {
  try {
    const output = await runCommand('cmd', ['/d', '/c', 'ver'])
    if (!output.success) return undefined
    const raw = output.stdout.toString('utf8').trim()
    const versionMatch = raw.match(/\d+\.\d+\.\d+\.\d+/)
    return versionMatch ? `Windows ${versionMatch[0]}` : undefined
  } catch {
    return undefined
  }
}

async function detectPowerShellVersion(
  command: string,
): Promise<string | undefined> {
  try {
    const output = await runCommand(command, [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ])
    if (!output.success) return undefined
    return output.stdout.toString('utf8').trim() || undefined
  } catch {
    return undefined
  }
}

async function detectBashVersion(command: string): Promise<string | undefined> {
  try {
    const output = await runCommand(command, ['--version'])
    if (!output.success) return undefined
    const firstLine = output.stdout.toString('utf8').trim().split(/\r?\n/)[0]
    return firstLine || undefined
  } catch {
    return undefined
  }
}

/**
 * Check if a script contains patterns that require an MSYS2-aware shell
 * (bash/sh) instead of cmd on Windows. MSYS2 binaries (grep, sed, awk,
 * find, etc.) hang when spawned directly by cmd because their cygwin DLL
 * isn't properly initialized without a MSYS2 parent process.
 */
export function needsMsys2Shell(script: string): boolean {
  if (/\/[a-zA-Z]\/|^\/(tmp|usr|etc|dev|home)\b/.test(script)) return true
  if (
    /\b(grep|sed|awk|find|xargs|chmod|chown|diff|patch|make|cut|sort|uniq|wc)\b/
      .test(script)
  ) {
    return true
  }
  return false
}

export function buildShellArgs(
  shell: string,
  script: string,
  args: string[],
): string[] {
  switch (shell) {
    case 'cmd':
      // Use /d (disable AutoRun) /s (strip outer quotes for /c) /c "script".
      // Combined with windowsRawArguments in spawn(), this passes the script
      // to cmd as-is without escaping internal double quotes.
      // Prepend chcp 65001 so extended Unicode is emitted as UTF-8.
      return [...args, '/d', '/s', '/c', `"chcp 65001 >nul & ${script}"`]
    case 'powershell':
    case 'pwsh':
      return [
        '-NoLogo',
        '-NoProfile',
        ...args,
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
      ]
    case 'git-bash':
    case 'sh':
    case 'bash':
      return [...args, '-c', script]
    default:
      return [...args, '-c', script]
  }
}
