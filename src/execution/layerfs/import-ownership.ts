import { ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { runBootstrapCommand, type BootstrapCommand, type BootstrapRun } from './bootstrap-command.ts'

const validDistribution = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
const refused = () => new ToolOutcomeUnknownError('LayerFS import ownership is active or cannot be established from complete read-only inventories; inspection refused. No worker was stopped.')
// All homes are considered. A candidate with an inaccessible command line cannot
// be distinguished from a retained managed helper. Never emit command lines.
const helperInventory = String.raw`$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); if (-not $all.Count) { throw 'Incomplete inventory' }; $p=@($all | Where-Object { $_.Name -match '^(node|electron|shadow)\.exe$' }); if (@($p | Where-Object { [string]::IsNullOrWhiteSpace($_.CommandLine) }).Count) { throw 'Incomplete inventory' }; $busy=@($p | Where-Object { $_.CommandLine -like '*LayerFSRuntime*' }); [Console]::Write($busy.Count)`

// The pinned worker entrypoint is api/runtime/src/worker/server.js. Assemble its
// needle at runtime: neither this Python process nor its launcher matches itself.
// This is a bounded census, not an SDK probe, endpoint request or cleanup script.
const linuxCensus = String.raw`import os, time, json
workers = 0
incomplete = False
needle = b'api/runtime/' + b'src/worker/' + b'server.js'
started = time.monotonic()
try:
    if os.geteuid() != 0:
        raise RuntimeError()
    with os.scandir('/proc') as entries:
        pids = []
        for entry in entries:
            if entry.name.isascii() and entry.name.isdigit():
                pids.append(entry.name)
                if len(pids) > 32768 or time.monotonic() - started > 10:
                    raise RuntimeError()
    if str(os.getpid()) not in pids:
        raise RuntimeError()
    for pid in pids:
        if time.monotonic() - started > 10:
            incomplete = True
            break
        try:
            with open('/proc/' + pid + '/cmdline', 'rb') as command:
                data = command.read(1048577)
            if len(data) > 1048576 or (data and not data.endswith(b'\0')):
                incomplete = True
            if needle in data:
                workers += 1
        except FileNotFoundError:
            pass
        except Exception:
            incomplete = True
except Exception:
    incomplete = True
print(json.dumps({'workers': workers, 'incomplete': incomplete}, separators=(',', ':')))
`

/** A moment-in-time, conservative ownership check, not an ownership lease.
 * The caller must separately authorize root inspection and the WSL startup race,
 * and serialize namespace admission. This function never initializes the SDK.
 */
export async function inspectInactiveImportWorker(distribution: string, signal: AbortSignal,
  run: BootstrapRun = runBootstrapCommand): Promise<{ ownership: 'inactive'; evidence: 'stopped_distribution' | 'no_layerfs_worker_process' }> {
  const checkAbort = () => { if (signal.aborted) throw new DOMException('LayerFS ownership inspection aborted.', 'AbortError') }
  checkAbort()
  if (!validDistribution(distribution)) throw refused()
  const execute = async (command: BootstrapCommand, utf16 = false): Promise<string> => {
    checkAbort()
    let receipt
    try { receipt = await run(command, signal) } catch { checkAbort(); throw refused() }
    checkAbort()
    // BootstrapRun retains at most 64 KiB of output; a full buffer may be a
    // truncated suffix. Refuse rather than accepting a well-formed tail.
    if (receipt.code !== 0 || receipt.stderr.length || receipt.stdout.length >= 65536
      || (receipt.diagnostic && (receipt.diagnostic.reason !== 'exit' || !receipt.diagnostic.launcherExited || receipt.diagnostic.exitCode !== 0))) throw refused()
    try {
      const encoding = utf16 && receipt.stdout.includes(0) ? 'utf-16le' : 'utf-8'
      return new TextDecoder(encoding, { fatal: true }).decode(receipt.stdout)
    } catch { throw refused() }
  }
  const inspectHelpers = async () => {
    const output = await execute({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', helperInventory], timeoutMs: 30000 })
    if (output !== '0') throw refused()
  }
  const inventory = async (running: boolean) => {
    const output = await execute({ file: 'wsl.exe', args: ['--list', ...(running ? ['--running'] : []), '--quiet'], timeoutMs: 30000 }, true)
    if (output === '') return []
    // WSL emits one newline-terminated name per row. Reject partial rows, blank
    // rows, notices, duplicates, replacement characters and embedded NULs.
    if (!output.endsWith('\n')) throw refused()
    const names = output.replace(/\r?\n$/, '').split(/\r?\n/)
    if (!names.every(validDistribution)) throw refused()
    const folded = names.map(name => name.toLowerCase())
    if (new Set(folded).size !== names.length) throw refused()
    return folded
  }
  await inspectHelpers()
  const installed = await inventory(false)
  const running = await inventory(true)
  const selected = distribution.toLowerCase()
  if (!installed.includes(selected) || running.some(name => !installed.includes(name))) throw refused()
  const active = running.includes(selected)
  if (active) {
    const output = await execute({ file: 'wsl.exe', args: ['--distribution', distribution, '--user', 'root', '--exec', 'python3', '-I', '-B', '-c', linuxCensus], timeoutMs: 30000 })
    // Only the exact schema emitted by our census is accepted (including no
    // duplicate keys, coercions, extra metadata or diagnostic output).
    const match = /^\{"workers":(0|[1-9][0-9]*),"incomplete":(true|false)\}\r?\n?$/.exec(output)
    if (!match || match[0] !== output || match[1] !== '0' || match[2] !== 'false') throw refused()
  }
  await inspectHelpers()
  checkAbort()
  return { ownership: 'inactive', evidence: active ? 'no_layerfs_worker_process' : 'stopped_distribution' }
}
