// Reviewed local fetch/patch helper; never runs upstream scripts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = resolve(root, '.upstream');
const revision = '5a2c9ad43e269164a8adc8978a733c40b1d38a8b';
function git(args, cwd = root) {
 const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
 if (result.error) throw result.error;
 if (result.status !== 0) throw new Error(result.stderr || `git failed ${result.status}`);
 return result.stdout.trimEnd();
}
const sync = process.argv[2] === '--sync';
if (existsSync(upstream)) {
 if (!sync) throw new Error('Existing .upstream: use --sync to update only the owned Shadow extension');
} else {
 if (sync) throw new Error('--sync requires existing pinned .upstream');
 git(['clone', '--no-checkout', '--', process.argv[2] ?? 'https://github.com/lahfir/agent-desktop.git', upstream]);
 git(['-c', 'core.hooksPath=NUL', 'checkout', '--detach', revision], upstream);
}
if (git(['rev-parse', 'HEAD'], upstream) !== revision) throw new Error('Upstream revision mismatch');
const lib = resolve(upstream, 'crates/windows/src/lib.rs');
const base = git(['show', `${revision}:crates/windows/src/lib.rs`], upstream);
const extension = '\n// Shadow restricted password-first observation extension (Apache-2.0).\n#[cfg(target_os = "windows")]\nmod shadow_observe;\n';
const current = readFileSync(lib, 'utf8').replaceAll('\r\n', '\n').trimEnd();
if (current !== base && current !== (base + '\n' + extension).trimEnd()) throw new Error('lib.rs contains non-owned edits; refusing overwrite');
writeFileSync(lib, base + '\n' + extension);
copyFileSync(resolve(root, 'patches/shadow_observe.rs'), resolve(upstream, 'crates/windows/src/shadow_observe.rs'));
const manifest = resolve(upstream, 'crates/windows/Cargo.toml');
const manifestBase = git(['show', revision + ':crates/windows/Cargo.toml'], upstream);
const dependency = '\n\n# Shadow restricted fingerprint dependency.\n[dependencies.sha2]\nversion = "=0.10.9"\n';
const manifestCurrent = readFileSync(manifest, 'utf8').replaceAll('\r\n','\n').trimEnd();
if (manifestCurrent !== manifestBase && manifestCurrent !== (manifestBase + dependency).trimEnd()) throw new Error('Upstream manifest has non-owned edits');
writeFileSync(manifest, manifestBase + dependency);
copyFileSync(resolve(root,'patches/shadow_gate.rs'),resolve(upstream,'crates/windows/src/shadow_gate.rs'));
console.log(`Verified ${revision}; synchronized owned module/dependency declarations and shadow_observe.rs/shadow_gate.rs only. Other upstream files untouched.`);
