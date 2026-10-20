import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Compile the existing independent input guard ahead of time. No PowerShell,
 * desktop reads, hooks or input are executed by the builder. The unused legacy
 * PowerShell launcher is deliberately excluded from the resulting source. */
export function prepareInputGuardSource(source: string): string {
  const bridge = '    internal sealed class ForegroundInputBridge : IDisposable {'
  const host = '    public static class ForegroundInputHost {'
  const start = source.indexOf(bridge), end = source.indexOf(host)
  if (start < 0 || end <= start || source.indexOf(bridge, start + 1) >= 0) throw new Error('Unexpected guard source layout')
  let result = source.slice(0, start) + source.slice(end)
  const event = 'var cancelled = new ManualResetEvent(false);'
  const reader = '            var reader = new Thread(() => {'
  if (result.split(event).length !== 2 || result.split(reader).length !== 2) throw new Error('Unexpected guard cancellation source')
  result = result.replace(event, 'var cancelled = new EventWaitHandle(false, EventResetMode.ManualReset, System.Environment.GetEnvironmentVariable("SHADOW_INPUT_CANCEL_EVENT"));')
  // A native cancel signal is independent of a blocked owner/UIA thread. Keep
  // the original EOF and owner watchdog as additional crash-cleanup paths.
  result = result.replace(reader, `            var cancellationWatchdog = new Thread(() => {
                cancelled.WaitOne();
                cancel();
                Thread.Sleep(1500);
                System.Environment.Exit(0);
            });
            cancellationWatchdog.IsBackground = true; cancellationWatchdog.Start();
${reader}`)
  if (result.includes('powershell.exe') || result.includes('Add-Type')) throw new Error('Runtime compilation leaked into guard source')
  return result
}

export async function buildInputGuard(root: string, output: string, options: { fixture?: boolean } = {}): Promise<{ sha256: string; sourceSha256: string }> {
  if (process.platform !== 'win32') throw new Error('The Windows input guard requires the Windows .NET Framework compiler')
  root = resolve(root)
  output = resolve(output)
  const framework = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const compiler = join(framework, 'csc.exe')
  await stat(compiler)
  const original = await readFile(join(root, 'src/execution/computer/windows-input.cs'), 'utf8')
  const source = prepareInputGuardSource(original)
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  const identityJson = JSON.stringify({ protocol: 1, backend: 'shadow-input-guard', sourceSha256 })
  const identityLiteral = '"' + identityJson.replaceAll('"', '\\"') + '"'
  const temporary = await mkdtemp(join(tmpdir(), 'shadow-input-guard-build-'))
  try {
    const input = join(temporary, 'guard.cs'), entry = join(temporary, 'entry.cs')
    await writeFile(input, source)
    await writeFile(entry, options.fixture
      ? 'class Program { static void Main() { System.Console.WriteLine(Shadow.InputFixture.Run()); } }'
      : `class Program { [System.MTAThread] static void Main(string[] args) {
          System.Console.InputEncoding = new System.Text.UTF8Encoding(false);
          System.Console.OutputEncoding = new System.Text.UTF8Encoding(false);
          if (args.Length == 1 && args[0] == "--identity") { System.Console.WriteLine(${identityLiteral}); return; }
          int owner;
          if (args.Length != 1 || !int.TryParse(args[0], out owner) || owner <= 0) System.Environment.Exit(2);
          Shadow.ForegroundInputHost.Run(int.Parse(args[0], System.Globalization.CultureInfo.InvariantCulture));
        } }`)
    await mkdir(dirname(output), { recursive: true })
    const files = [input, entry]
    if (options.fixture) files.push(join(root, 'src/execution/computer/testing/input.cs'))
    await run(compiler, ['/nologo', '/noconfig', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${output}`,
      ...['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${join(framework, name)}`), ...files], {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, LIB: framework },
    })
    const binary = await readFile(output)
    if (binary.length === 0) throw new Error('The input guard compiler produced an empty binary')
    return { sha256: createHash('sha256').update(binary).digest('hex'), sourceSha256 }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
