import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Build only. Never launches the interactive fixture: the user opens it after
 * switching the real computer-use host. No test key/text log is emitted. */
export async function buildComputerFixture(root: string, output: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The synthetic fixture requires Windows .NET Framework')
  const framework = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  let source = await readFile(join(root, 'src/execution/computer/testing/window.cs'), 'utf8')
  source = source.replace('ShowInTaskbar = false', 'ShowInTaskbar = true')
  const marker = '            form.Size = new Size(650, 480);'
  if (source.split(marker).length !== 2) throw new Error('Synthetic fixture source layout changed')
  source = source.replace(marker, `${marker}
            form.Controls.Add(new Button { AccessibleName = "Fixture disabled button", Text = "Disabled", Enabled = false, Location = new Point(480, 20), Width = 120 });
            form.Controls.Add(new TextBox { AccessibleName = "Fixture read-only input", Text = "Synthetic read-only", ReadOnly = true, Location = new Point(480, 70), Width = 120 });
            form.Controls.Add(new TextBox { AccessibleName = "Fixture long input", Text = new String('x', 2100) + "after", Location = new Point(480, 110), Width = 120 });`)
  const hash = createHash('sha256').update(source).digest('hex')
  const temporary = await mkdtemp(join(tmpdir(), 'shadow-computer-fixture-build-'))
  try {
    const input = join(temporary, 'window.cs'), entry = join(temporary, 'entry.cs')
    await writeFile(input, source)
    const identity = JSON.stringify({ protocol: 1, backend: 'shadow-computer-fixture', sourceSha256: hash }).replaceAll('"', '\\"')
    await writeFile(entry, `class Program { [System.STAThread] static void Main(string[] args) {
      if (args.Length == 1 && args[0] == "--identity") { System.Console.WriteLine("${identity}"); return; }
      System.Console.SetOut(System.IO.TextWriter.Null);
      ComputerFixture.RunInput();
    } }`)
    output = resolve(output)
    await mkdir(dirname(output), { recursive: true })
    await promisify(execFile)(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${output}`,
      ...['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'].map(name => `/reference:${join(framework, name)}`), input, entry], {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, LIB: framework },
    })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = resolve(process.argv[2] ?? join(root, 'integrations/agent-desktop/artifacts/testing/shadow-computer-fixture.exe'))
  await buildComputerFixture(root, output)
  console.log(`Built ${output}. Not launched; open it manually for authorized computer-use testing.`)
}
