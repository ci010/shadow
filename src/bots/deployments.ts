import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface BotSource { folderId: string; directory: string }
/** revision is the SHA-256 source identity, not a Git commit. gitCommit is local history only. */
export interface BotDeployment { id: string; revision: string; previous?: string; source: BotSource; mode: 'git' | 'bounded'; gitCommit?: string }
export interface FrozenBotSource { revision: string; files: Record<string, string> }
export type GitRunner = (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => Promise<string>;
export interface BotDeploymentsOptions { directory: string; projectId: string; runGit?: GitRunner; validate?: (files: Readonly<Record<string, string>>) => void | Promise<void> }
function identifier(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid identifier');
  return id;
}
function sourcePath(name: string): void {
  if (name.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || p.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe source path');
}
/** Bounded UTF-8 source only, cloned and frozen. No source evaluation or SDK dependency. */
export function freeze(input: Record<string, string>): FrozenBotSource {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected file record');
  const names = Object.keys(input).sort(); const seen = new Set<string>(); let size = 0;
  if (!names.length || names.length > 256) throw new Error('Source file count limit');
  const files: Record<string, string> = Object.create(null);
  for (const name of names) {
    sourcePath(name);
    const value = input[name];
    if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error('Expected UTF-8 source text');
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) throw new Error('Source path collision');
    seen.add(folded); size += Buffer.byteLength(value);
    if (size > 2 * 1024 * 1024) throw new Error('Source byte limit');
    files[name] = value;
  }
  for (const name of names) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) {
    if (seen.has(parent.normalize('NFC').toLowerCase())) throw new Error('File/directory collision');
  }
  const revision = createHash('sha256').update(JSON.stringify(names.map(name => [name, files[name]]))).digest('hex');
  return Object.freeze({ revision, files: Object.freeze(files) });
}
/** Rejects links (including directory ancestors), special files and concurrent edits; bounded traversal. */
export function freezeDirectory(directory: string): FrozenBotSource {
  const root = path.resolve(directory);
  for (let cursor = root;; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink source directory');
    if (path.dirname(cursor) === cursor) break;
  }
  const files: Record<string, string> = Object.create(null); let entries = 0; let bytes = 0;
  const walk = (dir: string, prefix: string, depth: number): void => {
    const before = fs.lstatSync(dir);
    if (!before.isDirectory() || depth > 32) throw new Error('Unsafe source directory');
    const handle = fs.opendirSync(dir);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (++entries > 512) throw new Error('Source entry limit');
        const name = prefix + entry.name; sourcePath(name);
        const absolute = path.join(dir, entry.name); const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) { walk(absolute, `${name}/`, depth + 1); continue; }
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Linked or special source file');
        if (stat.size > 2 * 1024 * 1024 - bytes) throw new Error('Source byte limit');
        const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Source changed');
          if (opened.size > 2 * 1024 * 1024 - bytes) throw new Error('Source byte limit');
          const buffer = Buffer.alloc(opened.size + 1); const count = fs.readSync(fd, buffer, 0, buffer.length, 0); const after = fs.fstatSync(fd);
          if (count !== opened.size || after.size !== opened.size || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs) throw new Error('Source changed');
          bytes += count; files[name] = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
        } finally { fs.closeSync(fd); }
      }
    } finally { handle.closeSync(); }
    const after = fs.lstatSync(dir);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) throw new Error('Source directory changed');
  };
  walk(root, '', 0); return freeze(files);
}
const runGit: GitRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn('git', [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', data => { if (error.length < 8192) error += data; });
  child.on('error', e => { clearTimeout(timer); reject(e); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`Git failed (${code}): ${error}`)); });
  child.stdin.on('error', () => {}); child.stdin.end(options.input);
});
function exists(file: string): boolean { try { fs.lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
function noLinks(target: string): void {
  const parts: string[] = []; for (let cursor = path.resolve(target);; cursor = path.dirname(cursor)) { parts.push(cursor); if (path.dirname(cursor) === cursor) break; }
  for (const part of parts.reverse()) { if (!exists(part)) break; if (fs.lstatSync(part).isSymbolicLink()) throw new Error('Symlink storage boundary'); }
}
function readJson(target: string): unknown {
  noLinks(target); const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Invalid bounded metadata'); const buffer = Buffer.alloc(16385); const count = fs.readSync(fd, buffer, 0, buffer.length, 0); if (count !== stat.size) throw new Error('Metadata changed or exceeds bound'); return JSON.parse(buffer.subarray(0, count).toString('utf8')); }
  finally { fs.closeSync(fd); }
}
function validSource(value: unknown): value is BotSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as BotSource;
  return typeof v.folderId === 'string' && v.folderId.length > 0 && v.folderId.length <= 128 && !/[\x00-\x1f]/.test(v.folderId) && typeof v.directory === 'string' && v.directory.length <= 4096 && !/[\x00-\x1f]/.test(v.directory);
}
/** Storage must be exclusively owned by Shadow, not writable by deployed source.
 * Callers stop affected runtimes before deploy/recovery. Journal + rename protects
 * process interruption, not filesystem/power-loss durability. Recovery is explicitly
 * offline; no guessed stale-lock timeout. Portable path checks are not an OS sandbox
 * against a hostile same-user process racing ancestor renames. Never evaluates source.
 */
export class BotDeployments {
  private root: string;
  private runner: GitRunner;
  constructor(private options: BotDeploymentsOptions) {
    this.root = path.resolve(options.directory, identifier(options.projectId)); this.runner = options.runGit ?? runGit;
    noLinks(this.root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(this.root).isDirectory()) throw new Error('Store root is not a directory');
  }
  freeze(files: Record<string, string>): FrozenBotSource { return freeze(files); }
  freezeDirectory(directory: string): FrozenBotSource { return freezeDirectory(directory); }
  private bot(id: string): string { const bot = path.join(this.root, identifier(id)); noLinks(bot); return bot; }
  runtimeDirectory(id: string): string { const target = path.join(this.bot(id), 'current', 'files'); noLinks(target); return target; }
  dataDirectory(id: string): string { return path.join(this.bot(id), 'data'); }
  private recover(bot: string): void {
    // Promotion journal precedes renames. A crash before the new current exists restores the old current.
    const journal = path.join(bot, 'promotion.json');
    if (!exists(journal)) return;
    if (exists(path.join(bot, '.lock'))) throw new Error('Deployment interrupted or busy: explicit operator recovery required');
    throw new Error('Interrupted promotion requires operator recovery');
  }
  read(id: string): { deployment: BotDeployment; files: Record<string, string> } | undefined {
    const bot = this.bot(id); this.recover(bot);
    if (!exists(path.join(bot, 'current'))) return undefined;
    return this.readSlot(bot, 'current');
  }
  private readSlot(bot: string, slot: string): { deployment: BotDeployment; files: Record<string, string> } {
    const target = path.join(bot, slot);
    noLinks(target);
    const deployment = readJson(path.join(target, 'deployment.json')) as BotDeployment;
    if (!deployment || typeof deployment !== 'object' || !validSource(deployment.source) || (deployment.previous !== undefined && (typeof deployment.previous !== 'string' || !/^[a-f0-9]{64}$/.test(deployment.previous))) || (deployment.gitCommit !== undefined && (typeof deployment.gitCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(deployment.gitCommit)))) throw new Error('Invalid deployment metadata');
    identifier(deployment.id);
    if (this.bot(deployment.id) !== bot || !/^[a-f0-9]{64}$/.test(deployment.revision) || !['git', 'bounded'].includes(deployment.mode)) throw new Error('Invalid deployment metadata');
    const snapshot = freezeDirectory(path.join(target, 'files'));
    if (snapshot.revision !== deployment.revision) throw new Error('Deployment integrity failure');
    return { deployment, files: snapshot.files };
  }
  list(): BotDeployment[] {
    return fs.readdirSync(this.root).filter(id => fs.lstatSync(path.join(this.root, id)).isDirectory()).map(id => this.read(id)?.deployment).filter((value): value is BotDeployment => !!value);
  }
  private git(bot: string, args: string[], input?: string): Promise<string> {
    const empty = path.join(bot, 'git-home');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(empty, 'config'), GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'BOT deployment', GIT_AUTHOR_EMAIL: 'bot@localhost', GIT_COMMITTER_NAME: 'BOT deployment', GIT_COMMITTER_EMAIL: 'bot@localhost' };
    return this.runner(['-c', `core.hooksPath=${path.join(empty, 'hooks')}`, '-c', 'commit.gpgSign=false', '-c', `core.attributesFile=${path.join(empty, 'attributes')}`, '-c', 'core.autocrlf=false', ...args], { cwd: bot, env, input });
  }
  async deploy(input: { id: string; source: BotSource; files: Record<string, string>; revision: string; expectedRevision?: string; signal?: AbortSignal }): Promise<BotDeployment> {
    input.signal?.throwIfAborted();
    identifier(input.id);
    if (!validSource(input.source)) throw new Error('Invalid source');
    input = { ...input, source: { ...input.source } };
    const frozen = freeze(input.files);
    if (frozen.revision !== input.revision) throw new Error('Approved source hash mismatch');
    await this.options.validate?.(frozen.files);
    input.signal?.throwIfAborted();
    const bot = this.bot(input.id); fs.mkdirSync(bot, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(bot).isDirectory()) throw new Error('BOT storage is not a directory');
    this.recover(bot);
    const lock = path.join(bot, '.lock'); fs.mkdirSync(lock);
    let staged: string | undefined; let committed = false;
    try {
      for (const name of ['current', 'previous', 'data', 'history.git', 'git-home']) noLinks(path.join(bot, name));
      const active = this.read(input.id)?.deployment;
      if (active?.revision !== input.expectedRevision) throw new Error('Active deployment changed');
      let available = true; try { await this.git(bot, ['--version']); } catch { available = false; }
      input.signal?.throwIfAborted();
      const managed = exists(path.join(bot, 'history.git'));
      if (!available && (managed || active?.mode === 'git')) throw new Error('Git unavailable for Git-managed BOT');
      if (active?.revision === frozen.revision) return active;
      const deployment: BotDeployment = { id: input.id, source: { ...input.source }, revision: frozen.revision, previous: active?.revision, mode: available ? 'git' : 'bounded' };
      staged = path.join(bot, `.staged-${randomUUID()}`); fs.mkdirSync(path.join(staged, 'files'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.dataDirectory(input.id), { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(frozen.files)) {
        const target = path.join(staged, 'files', name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
      }
      let oldCommit: string | undefined;
      if (available) {
        fs.mkdirSync(path.join(bot, 'git-home', 'hooks'), { recursive: true, mode: 0o700 });
        if (!managed) await this.git(bot, ['init', '--bare', '--template=', path.join(bot, 'history.git')]);
        const flags = [`--git-dir=${path.join(bot, 'history.git')}`, `--work-tree=${path.join(staged, 'files')}`];
        await this.git(bot, [...flags, 'read-tree', '--empty']);
        let index = '';
        for (const [name, content] of Object.entries(frozen.files)) {
          const blob = await this.git(bot, [...flags, 'hash-object', '-w', '--no-filters', '--stdin'], content);
          if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error('Invalid internal Git object');
          index += `100644 ${blob}\t${name}\n`;
        }
        await this.git(bot, [...flags, 'update-index', '--index-info'], index);
        const tree = await this.git(bot, [...flags, 'write-tree']);
        try { oldCommit = await this.git(bot, [...flags, 'rev-parse', '--verify', 'refs/heads/deployments']); } catch (error) { if (active?.mode === 'git') throw error; /* First internal commit. */ }
        const commit = await this.git(bot, [...flags, 'commit-tree', tree, ...(oldCommit ? ['-p', oldCommit] : [])], `Deployment ${frozen.revision}\n`);
        if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid internal Git commit');
        deployment.gitCommit = commit;
      }
      fs.writeFileSync(path.join(staged, 'deployment.json'), JSON.stringify(deployment), { flag: 'wx', mode: 0o600 });
      const current = path.join(bot, 'current'); const previous = path.join(bot, 'previous'); const saved = path.join(bot, `.previous-${randomUUID()}`);
      input.signal?.throwIfAborted();
      fs.writeFileSync(path.join(bot, 'promotion.json'), JSON.stringify({ staged: path.basename(staged), saved: path.basename(saved), oldCommit, git: available, activeRevision: active?.revision, nextRevision: deployment.revision }), { flag: 'wx', mode: 0o600 });
      let promoted = false;
      try {
        if (exists(previous)) fs.renameSync(previous, saved);
        if (exists(current)) fs.renameSync(current, previous);
        fs.renameSync(staged, current); promoted = true;
        if (available) await this.git(bot, [`--git-dir=${path.join(bot, 'history.git')}`, 'update-ref', 'refs/heads/deployments', deployment.gitCommit!, ...(oldCommit ? [oldCommit] : ['0'.repeat(40)])]);
        input.signal?.throwIfAborted();
        fs.unlinkSync(path.join(bot, 'promotion.json')); // Commit point. Cleanup below cannot fail the deployment.
        staged = undefined; committed = true;
      } catch (error) {
        if (available) await this.rollbackRef(bot, oldCommit);
        if (promoted) fs.renameSync(current, staged!);
        if (!exists(current) && exists(previous)) fs.renameSync(previous, current);
        if (exists(saved)) fs.renameSync(saved, previous);
        fs.unlinkSync(path.join(bot, 'promotion.json'));
        throw error;
      }
      try { fs.rmSync(saved, { recursive: true, force: true }); } catch { /* Orphan cleanup does not undo activation. */ }
      return deployment;
    } finally {
      if (staged && !exists(path.join(bot, 'promotion.json'))) fs.rmSync(staged, { recursive: true, force: true });
      try { fs.rmdirSync(lock); } catch (error) { if (!committed) throw error; /* Activated; stale lock needs offline recovery. */ }
    }
  }
  private async rollbackRef(bot: string, commit?: string): Promise<void> {
    await this.git(bot, [`--git-dir=${path.join(bot, 'history.git')}`, 'update-ref', ...(commit ? ['refs/heads/deployments', commit] : ['-d', 'refs/heads/deployments'])]);
  }
  /** Offline only: caller must establish that no writer survives. Incomplete transactions roll back. */
  async recoverInterrupted(id: string): Promise<void> {
    const bot = this.bot(id); const journal = path.join(bot, 'promotion.json');
    if (exists(journal)) {
      const state = readJson(journal) as { staged: string; saved: string; oldCommit?: string; git: boolean; activeRevision?: string; nextRevision: string };
      if (!state || typeof state.git !== 'boolean' || typeof state.nextRevision !== 'string' || !/^[a-f0-9]{64}$/.test(state.nextRevision) || (state.activeRevision !== undefined && (typeof state.activeRevision !== 'string' || !/^[a-f0-9]{64}$/.test(state.activeRevision))) || !/^\.staged-[a-f0-9-]{36}$/.test(state.staged) || !/^\.previous-[a-f0-9-]{36}$/.test(state.saved) || (state.oldCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(state.oldCommit))) throw new Error('Invalid promotion journal');
      const staged = path.join(bot, state.staged); const saved = path.join(bot, state.saved);
      const current = path.join(bot, 'current'); const previous = path.join(bot, 'previous');
      noLinks(staged); noLinks(saved); noLinks(current); noLinks(previous);
      if (state.git) await this.rollbackRef(bot, state.oldCommit);
      if (exists(current)) {
        const revision = this.readSlot(bot, 'current').deployment.revision;
        if (revision !== state.activeRevision) {
          if (revision !== state.nextRevision || exists(staged)) throw new Error('Ambiguous interrupted current');
          fs.renameSync(current, staged);
        }
      }
      if (!exists(current) && state.activeRevision !== undefined) {
        if (!exists(previous) || this.readSlot(bot, 'previous').deployment.revision !== state.activeRevision) throw new Error('Missing previous active deployment');
        fs.renameSync(previous, current);
      }
      if (exists(saved)) {
        if (exists(previous)) throw new Error('Ambiguous interrupted promotion');
        fs.renameSync(saved, previous);
      }
      fs.rmSync(staged, { recursive: true, force: true });
      fs.unlinkSync(journal);
    }
    fs.rmSync(path.join(bot, '.lock'), { recursive: true, force: true });
    for (const name of fs.readdirSync(bot)) if (/^\.staged-[a-f0-9-]{36}$/.test(name)) fs.rmSync(path.join(bot, name), { recursive: true, force: true });
  }
  async restorePrevious(id: string): Promise<BotDeployment> {
    const active = this.read(id); if (!active?.deployment.previous) throw new Error('No previous deployment');
    const previous = this.readSlot(this.bot(id), 'previous');
    return this.deploy({ id, source: previous.deployment.source, ...freeze(previous.files), expectedRevision: active.deployment.revision });
  }
}
