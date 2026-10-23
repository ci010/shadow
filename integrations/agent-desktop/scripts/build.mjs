import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? 'x86_64-pc-windows-msvc';
if (process.platform !== 'win32' || !['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(target)) throw new Error('Windows MSVC target required');
function run(command, args) {
 const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
 if (result.error) throw result.error;
 if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
run('cargo', ['--version']);
if (!existsSync(resolve(root, '.upstream/crates/windows/src/shadow_observe.rs'))) throw new Error('Run scripts/fetch.mjs first');
if (!existsSync(resolve(root, 'Cargo.lock'))) {
 if (!process.argv.includes('--resolve-lock')) throw new Error('Missing local Cargo.lock; pass --resolve-lock for explicit initial resolution');
 run('cargo', ['generate-lockfile']);
}
// Refresh only the owned upstream patch before Cargo's incremental dependency check.
run(process.execPath, ['scripts/fetch.mjs', '--sync']);
run('cargo', ['build', '--release', '--locked', '--target', target]);
const architecture = target === 'x86_64-pc-windows-msvc' ? 'x64' : 'arm64';
const destination = resolve(root, 'artifacts', "win32-" + architecture);
mkdirSync(destination, { recursive: true });
copyFileSync(resolve(root, 'target', target, 'release', 'shadow_agent_desktop.dll'), resolve(destination, 'shadow-agent-desktop.node'));
const { buildInputGuard } = await import(pathToFileURL(resolve(root, "../../scripts/agent-desktop-input-guard.ts")).href);
await buildInputGuard(resolve(root, "../.."), resolve(destination, "shadow-input-guard.exe"));
if (architecture === process.arch) run(process.execPath, ['scripts/identity.mjs', resolve(destination, 'shadow-agent-desktop.node')]);
const { recordNativeBuild } = await import(pathToFileURL(resolve(root, '../../scripts/agent-desktop-integrity.ts')).href);
await recordNativeBuild(resolve(root, '../..'), architecture);
console.log(`Built ${destination}; source/binary integrity recorded. No real desktop UI tested; not signed.`);
