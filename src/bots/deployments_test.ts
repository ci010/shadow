import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BotDeployments, freeze, freezeDirectory, type GitRunner } from './deployments.js';

const source = { folderId: 'folder', directory: 'source' };
function fixture(t: { after: (fn: () => void) => void }, runGit?: GitRunner) {
  const root = fs.mkdtempSync(path.resolve('.deployment-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new BotDeployments({ directory: root, projectId: 'project', runGit }) };
}
const missing: GitRunner = async () => { throw new Error('ENOENT'); };

test('bounded frozen deployment, optimistic confirmation, previous restore and separate data', async t => {
  const { root, store } = fixture(t, missing);
  const mutable = { 'bot.ts': 'one' }; const frozen = store.freeze(mutable); mutable['bot.ts'] = 'edited';
  assert.ok(Object.isFrozen(frozen.files));
  const first = await store.deploy({ id: 'alpha', source, ...frozen });
  assert.equal(first.mode, 'bounded'); assert.equal(store.read('alpha')?.files['bot.ts'], 'one');
  fs.writeFileSync(path.join(store.dataDirectory('alpha'), 'state'), 'retained');
  const stable = store.runtimeDirectory('alpha');
  const second = freeze({ 'bot.ts': 'two' });
  await assert.rejects(store.deploy({ id: 'alpha', source, ...second }), /changed/);
  await store.deploy({ id: 'alpha', source, ...second, expectedRevision: first.revision });
  assert.equal(store.runtimeDirectory('alpha'), stable);
  assert.equal(store.read('alpha')?.deployment.previous, first.revision);
  await store.restorePrevious('alpha');
  assert.equal(store.read('alpha')?.files['bot.ts'], 'one');
  assert.equal(fs.readFileSync(path.join(store.dataDirectory('alpha'), 'state'), 'utf8'), 'retained');
  assert.deepEqual(fs.readdirSync(path.join(root, 'project', 'alpha')).filter(n => n === 'current' || n === 'previous').sort(), ['current', 'previous']);
  assert.equal(store.list().length, 1);
});

test('hash mismatch, validation failure and mutable deployed edits are rejected', async t => {
  const { root, store } = fixture(t, missing); const first = freeze({ 'bot.ts': 'one' });
  await assert.rejects(store.deploy({ id: 'alpha', source, ...first, revision: 'bad' }), /hash/);
  await store.deploy({ id: 'alpha', source, ...first });
  const failing = new BotDeployments({ directory: root, projectId: 'project', runGit: missing, validate: () => { throw new Error('invalid source'); } });
  await assert.rejects(failing.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision }), /invalid/);
  assert.equal(store.read('alpha')?.deployment.revision, first.revision);
  fs.writeFileSync(path.join(store.runtimeDirectory('alpha'), 'bot.ts'), 'tampered');
  assert.throws(() => store.read('alpha'), /integrity/);
});

test('paths, collisions, bounds and text are validated', () => {
  for (const name of ['../bad', '/bad', 'x\\y', '.git/config', 'a/../b', 'C:x', 'a//b', 'NUL', 'x.']) assert.throws(() => freeze({ [name]: 'x' }));
  assert.throws(() => freeze({ A: 'x', a: 'y' }), /collision/);
  assert.throws(() => freeze({ a: 'x', 'a/b': 'y' }), /collision/);
  assert.throws(() => freeze({ a: 'x'.repeat(2 * 1024 * 1024 + 1) }), /byte limit/);
  assert.throws(() => freeze({ a: '\ud800' }), /UTF-8/);
  assert.equal(freeze({ b: 'b', a: 'a' }).revision, freeze({ a: 'a', b: 'b' }).revision);
});

test('directory snapshot rejects symlinks, hardlinks and non-UTF8; frozen source survives edits', async t => {
  const { root, store } = fixture(t, missing); const dir = path.join(root, 'source'); fs.mkdirSync(dir);
  const file = path.join(dir, 'bot.ts'); fs.writeFileSync(file, 'original');
  const prepared = freezeDirectory(dir); fs.writeFileSync(file, 'modified');
  await store.deploy({ id: 'alpha', source, ...prepared });
  assert.equal(store.read('alpha')?.files['bot.ts'], 'original');
  fs.linkSync(file, path.join(dir, 'hard')); assert.throws(() => freezeDirectory(dir), /Linked/); fs.unlinkSync(path.join(dir, 'hard'));
  fs.symlinkSync(file, path.join(dir, 'link')); assert.throws(() => freezeDirectory(dir), /Linked/); fs.unlinkSync(path.join(dir, 'link'));
  fs.writeFileSync(file, Buffer.from([0xff])); assert.throws(() => freezeDirectory(dir));
});

test('actual git probe and local history; later missing git fails closed', async t => {
  const { root, store } = fixture(t);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ '.gitignore': '*.ts', 'bot.ts': 'one' }) });
  assert.equal(first.mode, 'git');
  assert.ok(fs.existsSync(path.join(root, 'project', 'alpha', 'history.git', 'objects')));
  const withoutGit = new BotDeployments({ directory: root, projectId: 'project', runGit: missing });
  await assert.rejects(withoutGit.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision }), /Git unavailable/);
  assert.equal(store.read('alpha')?.deployment.revision, first.revision);
  await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision });
});

test('git failures preserve current and previous; neutral environment/config and no hooks', async t => {
  const calls: string[][] = []; let fail = false;
  const fake: GitRunner = async (args, opts) => {
    calls.push([...args]);
    assert.equal(opts.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(opts.env.GIT_DIR, undefined);
    assert.ok(args.some(a => a.startsWith('core.hooksPath=')));
    if (args.includes('--version')) return 'git version test';
    if (args.includes('rev-parse')) return 'a'.repeat(40);
    if (args.includes('init')) fs.mkdirSync(args.at(-1)!, { recursive: true });
    if (fail && args.includes('write-tree')) throw new Error('injected failure');
    return 'a'.repeat(40);
  };
  const { store } = fixture(t, fake);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const second = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision });
  fail = true;
  await assert.rejects(store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'three' }), expectedRevision: second.revision }), /injected/);
  assert.equal(store.read('alpha')?.deployment.revision, second.revision);
  assert.equal(store.read('alpha')?.deployment.previous, first.revision);
  assert.ok(!calls.some(args => args.includes('push')));
});

test('interrupted promotion fails closed and explicit offline recovery restores active and previous', async t => {
  const { root, store } = fixture(t, missing);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const second = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision });
  const bot = path.join(root, 'project', 'alpha');
  const staged = '.staged-11111111-1111-1111-1111-111111111111'; const saved = '.previous-22222222-2222-2222-2222-222222222222';
  fs.mkdirSync(path.join(bot, '.lock')); fs.mkdirSync(path.join(bot, staged));
  fs.writeFileSync(path.join(bot, 'promotion.json'), JSON.stringify({ staged, saved, git: false, activeRevision: second.revision, nextRevision: freeze({ 'bot.ts': 'three' }).revision }));
  fs.renameSync(path.join(bot, 'previous'), path.join(bot, saved));
  fs.renameSync(path.join(bot, 'current'), path.join(bot, 'previous'));
  assert.throws(() => store.read('alpha'), /interrupted/);
  await store.recoverInterrupted('alpha');
  assert.equal(store.read('alpha')?.deployment.revision, second.revision);
  await store.restorePrevious('alpha');
  assert.equal(store.read('alpha')?.deployment.revision, first.revision);
});

test('storage symlink boundaries and bounded metadata runtime validation', async t => {
  const { root, store } = fixture(t, missing);
  await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const slot = path.join(root, 'project', 'alpha', 'current'); const metadata = path.join(slot, 'deployment.json');
  const original = fs.readFileSync(metadata, 'utf8');
  fs.writeFileSync(metadata, JSON.stringify({ ...JSON.parse(original), source: { folderId: 42, directory: false } }));
  assert.throws(() => store.read('alpha'), /metadata/);
  fs.writeFileSync(metadata, 'x'.repeat(16385)); assert.throws(() => store.read('alpha'), /bounded/);
  fs.unlinkSync(metadata); const external = path.join(root, 'external.json'); fs.writeFileSync(external, original); fs.symlinkSync(external, metadata);
  assert.throws(() => store.read('alpha'), /Symlink/); fs.unlinkSync(metadata); fs.writeFileSync(metadata, original);
  fs.linkSync(metadata, path.join(root, 'metadata-hardlink')); assert.throws(() => store.read('alpha'), /bounded/);
  const alias = path.join(root, 'alias'); fs.symlinkSync(path.join(root, 'project'), alias, 'dir');
  assert.throws(() => new BotDeployments({ directory: alias, projectId: 'other' }), /Symlink/);
});

test('Git ref failure after directory swap rolls back both current and previous; unchanged content has no new commit', async t => {
  let head: string | undefined; let serial = 0; let fail = false; let commits = 0;
  const fake: GitRunner = async (args) => {
    if (args.includes('--version')) return 'git';
    if (args.includes('init')) fs.mkdirSync(args.at(-1)!, { recursive: true });
    if (args.includes('rev-parse')) { if (!head) throw new Error('no parent'); return head; }
    if (args.includes('commit-tree')) { commits++; return (++serial).toString(16).padStart(40, '0'); }
    if (args.includes('update-ref')) {
      if (fail) { fail = false; throw new Error('ref failed'); }
      head = args.includes('-d') ? undefined : args[args.indexOf('refs/heads/deployments') + 1];
    }
    return 'a'.repeat(40);
  };
  const { store } = fixture(t, fake);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const second = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision });
  const oldHead = head; fail = true;
  await assert.rejects(store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'three' }), expectedRevision: second.revision }), /ref failed/);
  assert.equal(head, oldHead); assert.equal(store.read('alpha')?.deployment.revision, second.revision);
  assert.equal(store.read('alpha')?.deployment.previous, first.revision);
  const before = commits;
  await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: second.revision });
  assert.equal(commits, before);
});

test('abort and concurrent deployment preserve active snapshot', async t => {
  const { root, store } = fixture(t, missing);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision, signal: controller.signal }));
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: GitRunner = async () => { entered(); await gate; throw new Error('missing'); };
  const other = new BotDeployments({ directory: root, projectId: 'other', runGit: slow });
  const files = { 'bot.ts': 'approved' }; const snapshot = freeze(files);
  const pending = other.deploy({ id: 'beta', source, files, revision: snapshot.revision }); await ready;
  files['bot.ts'] = 'edited';
  const rival = new BotDeployments({ directory: root, projectId: 'other', runGit: missing });
  await assert.rejects(rival.deploy({ id: 'beta', source, ...freeze({ 'bot.ts': 'rival' }) }), /EEXIST/);
  release(); await pending;
  assert.equal(other.read('beta')?.files['bot.ts'], 'approved');
  assert.equal(store.read('alpha')?.deployment.revision, first.revision);
});

test('offline recovery of post-swap crash restores Git head and remains repeatable after partial recovery', async t => {
  let head: string | undefined; let serial = 0;
  const fake: GitRunner = async args => {
    if (args.includes('init')) fs.mkdirSync(args.at(-1)!, { recursive: true });
    if (args.includes('rev-parse')) { if (!head) throw new Error('empty'); return head; }
    if (args.includes('commit-tree')) return (++serial).toString(16).padStart(40, '0');
    if (args.includes('update-ref')) head = args.includes('-d') ? undefined : args[args.indexOf('refs/heads/deployments') + 1];
    return 'a'.repeat(40);
  };
  const { root, store } = fixture(t, fake);
  const first = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'one' }) });
  const second = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'two' }), expectedRevision: first.revision });
  const third = await store.deploy({ id: 'alpha', source, ...freeze({ 'bot.ts': 'three' }), expectedRevision: second.revision });
  const bot = path.join(root, 'project', 'alpha');
  const staged = '.staged-11111111-1111-1111-1111-111111111111'; const saved = '.previous-22222222-2222-2222-2222-222222222222';
  fs.mkdirSync(path.join(bot, saved, 'files'), { recursive: true }); fs.writeFileSync(path.join(bot, saved, 'files', 'bot.ts'), 'one'); fs.writeFileSync(path.join(bot, saved, 'deployment.json'), JSON.stringify(first));
  const journal = { staged, saved, git: true, activeRevision: second.revision, nextRevision: third.revision, oldCommit: second.gitCommit };
  fs.writeFileSync(path.join(bot, 'promotion.json'), JSON.stringify(journal));
  await store.recoverInterrupted('alpha');
  assert.equal(head, second.gitCommit); assert.equal(store.read('alpha')?.deployment.revision, second.revision);
  // Simulate recovery itself interrupted after all rollback renames/removal, before journal removal.
  fs.writeFileSync(path.join(bot, 'promotion.json'), JSON.stringify(journal));
  await store.recoverInterrupted('alpha');
  assert.equal(store.read('alpha')?.deployment.revision, second.revision);
  assert.equal(store.read('alpha')?.deployment.previous, first.revision);
});
