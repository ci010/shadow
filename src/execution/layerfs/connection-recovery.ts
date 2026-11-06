import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { runBootstrapCommand, type BootstrapRun } from './bootstrap-command.ts'

const inventoryText = (value: Buffer) => (value.includes(0) ? value.toString('utf16le') : value.toString('utf8')).replace(/^\uFEFF/, '')
// Query only; no process termination, WSL startup, endpoint access or SDK import.
const helperInventory = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|electron|shadow)\\.exe$' }); if (@($p | Where-Object { -not $_.CommandLine }).Count) { throw 'Process inventory incomplete' }; $busy=@($p | Where-Object { $_.CommandLine -like '*--input-type=module*' -and $_.CommandLine -like '*LayerFSRuntime*' }); [Console]::Write($busy.Count)`

/** Deliberately narrow: only a never-opened host runtime on a stopped distro.
 * Existing runtime directories (including symlinks) require operator reconciliation,
 * even if their worker appears down. No uncertain Init/import is recoverable here.
 */
export async function inspectUnstartedConnection(home: string, distribution: string, signal: AbortSignal,
  run: BootstrapRun = runBootstrapCommand): Promise<void> {
  signal.throwIfAborted()
  try { await lstat(join(projectDataPaths(home).state, 'layerfs', 'runtime')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolOutcomeUnknownError('LayerFS runtime directory cannot be inspected; recovery refused.')
    const processes = await run({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', helperInventory], timeoutMs: 30000 }, signal)
    if (processes.code !== 0 || processes.stderr.length || inventoryText(processes.stdout).trim() !== '0') throw new ToolOutcomeUnknownError('A managed helper may still exist or process inventory is incomplete; connection recovery refused. No process was stopped.')
    const installed = await run({ file: 'wsl.exe', args: ['--list', '--quiet'], timeoutMs: 30000 }, signal)
    const inventory = await run({ file: 'wsl.exe', args: ['--list', '--running', '--quiet'], timeoutMs: 30000 }, signal)
    const names = (value: Buffer) => inventoryText(value).split(/\r?\n/).map(name => name.trim()).filter(Boolean)
    const all = names(installed.stdout), running = names(inventory.stdout)
    const valid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    const same = (name: string) => name.toLowerCase() === distribution.toLowerCase()
    if (installed.code !== 0 || inventory.code !== 0 || installed.stderr.length || inventory.stderr.length
      || !all.every(valid) || !running.every(valid) || !all.some(same) || running.some(same)
      || running.some(name => !all.some(known => known.toLowerCase() === name.toLowerCase()))) {
      throw new ToolOutcomeUnknownError('The selected WSL distribution is running, missing, or its inventory is incomplete; connection recovery refused. No distribution was stopped.')
    }
    signal.throwIfAborted()
    // Recheck after asynchronous OS inventory, never accept a new runtime directory.
    try { await lstat(join(projectDataPaths(home).state, 'layerfs', 'runtime')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  throw new ToolNoEffectError('An SDK runtime directory exists; this is not a never-started connection. Preserve it for operator reconciliation, not automatic recovery.')
}
