/** Embedded in the isolated SDK process. Only official @layerfs/agent v1.1
 * filesystem calls operate on files. Shell is exclusively user-requested exec. */
export const committedRunner = String.raw`
let journalHandle, journalHandles = [], keepJournal = false;
const originalBranch = ws?.branch ?? a.branch;
// Pinned v1.1 write/files.rs and sandbox/values.rs: only these two
// publication outcomes prove a settled checkpoint; UpToDate may have no head.
function checkpointReceipt(value, branch) {
 const hex = s => typeof s === 'string' && /^[a-f0-9]+$/.test(s) && s.length % 2 === 0;
 if (!value || (branch !== undefined && value.branch !== branch)) throw Error('Invalid SDK checkpoint branch identity');
 if (value.kind === 'Committed' && hex(value.head) && value.commit?.id === value.head && hex(value.commit.root)) return value;
 if (value.kind === 'UpToDate' && (value.head === null || hex(value.head)) && hex(value.root)) return value;
 throw Error('Unrecognized or incomplete SDK checkpoint receipt; retain evidence');
}
async function phase(name, detail = {}) {
 for (const handle of journalHandles) { await handle.write(JSON.stringify({ phase: name, project, action, branch: originalBranch, resources:a.resources, owner:a.owner, ...detail }) + '\n'); await handle.sync(); }
 checkCancellation();
}
async function acquireJournal() {
 if (!a.journal) throw Error('A durable LayerFS operation journal is required');
 await reserveResources();
 // From this point any partial journal creation is retained with the atomic
 // reservation set. No other owner can acquire or remove these resources.
 keepJournal = true;
 for (const path of a.journals) {
  await mkdir(dirname(path), {recursive:true});
  const handle = await open(path, 'wx', 0o600);
  journalHandles.push(handle); journalHandle ??= handle;
 }
 await phase('admitted');
 keepJournal = false;
}
async function ensureUnmounted() {
 let pos = 0;
 for (let pages = 0; pages < 100; pages++) {
  const page = await client.project.list_sandboxes(100, pos);
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw Object.assign(Error('Invalid sandbox inventory; cannot prove unmounted state'), {shadowRefusal:true});
  for (const sandbox of page.items) {
   if (!Number.isSafeInteger(sandbox.workspaces) || sandbox.workspaces < 0) throw Error('Invalid workspace inventory');
   if (!sandbox.workspaces) continue;
   let mountPos=0;
   for(let mountPages=0;;mountPages++) {
    if(mountPages>=100) throw Error('Workspace inventory bound exceeded');
    const mounts=await client.sandbox.list_workspaces(sandbox.sandbox,100,mountPos);
    if(!Array.isArray(mounts.items) || typeof mounts.hasMore!=='boolean') throw Error('Invalid mount inventory');
    for(const mount of mounts.items) {
     // Official v1.1 daemon metadata, not sandbox number, path or local ledger.
     if(typeof mount.branch!=='string' || !mount.branch || a.resources===null || a.resources.includes(mount.branch)) throw Object.assign(Error('Mounted LayerFS resource overlaps, or has unknown branch ownership; explicitly reconcile/checkpoint/close it. No inferred branch or discard.'), {code:'MountedWorkspace',shadowRefusal:true});
    }
    if(!mounts.hasMore) break;
    if(!Number.isSafeInteger(mounts.nextPagePos) || mounts.nextPagePos<=mountPos) throw Error('Invalid mount pagination');
    mountPos=mounts.nextPagePos;
   }
  }
  if (!page.hasMore) return;
  if (!Number.isSafeInteger(page.nextPagePos) || page.nextPagePos <= pos) throw Error('Invalid inventory pagination');
  pos = page.nextPagePos;
 }
 throw Error('Inventory bound exceeded; cannot prove unmounted state');
}
async function committedFile() {
 await ensureUnmounted();
 const ref = ws.branch;
 if (action === 'write') {
  if (ref === 'main') throw Object.assign(Error('LayerFS main is readonly; fork a branch.'), {code:'ReadOnly'});
  await phase('fs-mutation-dispatched', {path:a.path, operation:a.match === undefined ? 'write' : 'edit'});
  keepJournal = true;
  try {
   const receipt = a.match === undefined ? await client.fs.write(ref, a.path, a.content, 'Shadow write')
    : await client.fs.edit(ref, a.path, a.match, a.content, 'Shadow exact edit');
   checkpointReceipt(receipt, ref);
   keepJournal = false;
   return receipt;
  } catch (e) {
   // Only explicit SDK refusals attest a completed attempt. No generic error
   // or transport Unknown releases the durable exclusion marker.
   if (definiteRefusal(e)) keepJournal = false;
   throw e;
  }
 }
 if (action === 'search') return a.handler === 'glob'
  ? await client.fs.glob(ref, a.query, a.path, a.limit, a.offset)
  : await client.fs.grep(ref, a.query, a.path, a.limit, a.offset);
 const stat = await client.fs.stat(ref, a.path);
 if (stat.type === 'directory' || stat.kind === 'directory' || stat.type === 'dir' || stat.kind === 'Directory') return { directory: await client.fs.list(ref, a.path, a.limit ?? 100, a.offset ?? 0) };
 if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > 256 * 1024) throw Object.assign(Error('LayerFS text read exceeds 256 KiB or has no bounded size.'), {code:'ReadLimit'});
 if (typeof stat.root !== 'string' || !stat.root) throw Error('SDK stat has no snapshot root; incomplete text refused');
 let start = a.start ?? 1, text = '', last;
 for (let pages = 0; pages < 1000; pages++) {
  const result = await client.fs.read(ref, a.path, start, a.end);
  if (result.root !== stat.root) throw Error('Branch changed during paged read; incomplete snapshot refused');
  if (typeof result.text !== 'string' || typeof result.truncated !== 'boolean' || result.lineTruncated !== false) throw Error('SDK clipped a line; incomplete text is refused. Binary reads are unsupported.');
  text += result.text; last = result;
  if (Buffer.byteLength(text) > 256 * 1024) throw Error('LayerFS text read exceeds 256 KiB');
  if (!result.truncated) return { ...last, text, startLine: a.start ?? 1 };
  if (!Number.isSafeInteger(result.nextLine) || result.nextLine <= start) throw Error('Invalid SDK read continuation; incomplete text refused');
  start = result.nextLine;
 }
 throw Error('SDK read page bound exceeded; incomplete text refused');
}
`;
