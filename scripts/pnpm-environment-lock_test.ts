import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

// pnpm 12 stores environment and ordinary dependencies in separate YAML documents.
// Only environment pins must be SHA-512: npm signatures cannot cover SHA-1 pins.
function checkEnvironmentLock(source: string, packageManager: string): void {
  const documents = parseAllDocuments(source).map((doc) => {
    assert.deepEqual(doc.errors, []);
    return doc.toJSON();
  });
  const environments = documents.filter((doc) => Object.values(doc?.importers ?? {}).some(
    (importer: any) => importer.packageManagerDependencies || importer.configDependencies,
  ));
  assert.ok(environments.length > 0, 'missing pnpm environment document');
  const pin = packageManager.match(/^pnpm@([^+]+)(?:\+.*)?$/)?.[1];
  assert.ok(pin, 'packageManager must pin pnpm');
  let foundManager = false;
  for (const environment of environments) {
    const packages = environment.packages ?? {};
    for (const importer of Object.values(environment.importers) as any[]) {
      if (importer.packageManagerDependencies?.pnpm) {
        assert.equal(importer.packageManagerDependencies.pnpm.specifier, pin);
        assert.equal(importer.packageManagerDependencies.pnpm.version, pin);
        assert.ok(packages[`pnpm@${pin}`], 'missing pinned pnpm package');
        foundManager = true;
      }
    }
    assert.ok(Object.keys(packages).length > 0, 'empty environment packages');
    for (const [id, pkg] of Object.entries(packages) as [string, any][]) {
      const integrity = pkg.resolution?.integrity;
      assert.match(integrity ?? '', /^sha512-[A-Za-z0-9+/]{86}==$/, `${id}: environment pins require SHA-512`);
      assert.equal(Buffer.from(integrity.slice(7), 'base64').toString('base64'), integrity.slice(7));
    }
    for (const snapshot of Object.values(environment.snapshots ?? {}) as any[]) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(snapshot[field] ?? {})) {
          assert.ok(packages[`${name}@${version}`], `missing environment dependency ${name}@${version}`);
        }
      }
    }
  }
  assert.ok(foundManager, 'missing package manager pin');
}

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('committed pnpm environment pins support npm signature verification', () => {
  checkEnvironmentLock(lock, packageManager);
});

test('reject SHA-1, missing platform integrity, missing packages and pin drift', () => {
  const docs = parseAllDocuments(lock).map((doc) => doc.toJSON());
  const env = docs[0];
  const id = Object.keys(env.packages)[0];
  // Keep the real multi-document fixture so this checks document scoping too.
  for (const bad of ['sha1-RMxgFtcIND5i9y73LgL9DiKGZmg=', '', 'sha512-invalid']) {
    assert.throws(() => checkEnvironmentLock(lock.replace(env.packages[id].resolution.integrity, bad), packageManager));
  }
  assert.throws(() => checkEnvironmentLock(lock, 'pnpm@0.0.0'));
  assert.throws(() => checkEnvironmentLock(lock.slice(lock.indexOf('\n---\n') + 1), packageManager));
  assert.throws(() => checkEnvironmentLock(lock.replace(`  '${id}':`, "  'missing@0.0.0':"), packageManager));
});

test('ordinary dependency SHA-1 is not an environment identity constraint', () => {
  checkEnvironmentLock(`${lock}\n---\npackages:\n  ordinary@1.0.0:\n    resolution: {integrity: sha1-example}\n`, packageManager);
});
