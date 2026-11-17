export const conversationArchiveQueries = {
  all: 'SELECT summary,at,id FROM archives WHERE committed=1 AND (at,id) > (?,?) ORDER BY at,id LIMIT ?',
  project: 'SELECT summary,at,id FROM archives WHERE committed=1 AND project=? AND (at,id) > (?,?) ORDER BY at,id LIMIT ?',
} as const

/** Self-contained worker source works in tsx and bundled builds without worker assets. */
export const conversationArchiveWorkerSource = String.raw`
const pageQueries=${JSON.stringify(conversationArchiveQueries)};
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {gzipSync,gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {existsSync,mkdirSync}=require('node:fs');
const {dirname}=require('node:path');
let db;
const hash=b=>createHash('sha256').update(b).digest('hex');
function database(create=false){
 if(db)return db;if(!create&&!existsSync(workerData.path))return;
 if(workerData.readOnly&&create)throw Error('Read-only archive');
 if(!workerData.readOnly)mkdirSync(dirname(workerData.path),{recursive:true});
 db=new DatabaseSync(workerData.path,{readOnly:workerData.readOnly});db.exec('PRAGMA busy_timeout=2000');
 if(!workerData.readOnly)db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,project TEXT,at TEXT,summary TEXT,state TEXT,pending TEXT,committed INTEGER DEFAULT 0); CREATE INDEX IF NOT EXISTS archive_page ON archives(committed,at,id); CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY,owner TEXT,total INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS blocks(physical TEXT,start INTEGER,count INTEGER,size INTEGER,checksum TEXT,data BLOB,PRIMARY KEY(physical,start)); CREATE INDEX IF NOT EXISTS archive_pending ON archives(id) WHERE committed=1 AND pending IS NOT NULL; CREATE INDEX IF NOT EXISTS archive_project_page ON archives(committed,project,at,id); CREATE INDEX IF NOT EXISTS segment_owner ON segments(owner); CREATE TABLE IF NOT EXISTS resources(project TEXT,folder TEXT,workdir TEXT,PRIMARY KEY(project,folder,workdir));');return db;
}
function canonical(v){return JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);}
function decode(r){if(!Number.isSafeInteger(r.start)||r.start<0||!Number.isSafeInteger(r.count)||r.count<1||r.size>16777216||r.size<2)throw Error('Archive block metadata corruption');const b=gunzipSync(r.data,{maxOutputLength:16777216});if(b.length!==r.size||hash(b)!==r.checksum)throw Error('Archive checksum mismatch');const records=JSON.parse(b.toString());if(!Array.isArray(records)||records.length!==r.count||records.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('Archive record count corruption');return records;}
function verify(d,id,pending,committed){
 const row=d.prepare('SELECT state,committed FROM archives WHERE id=?').get(id);if(!row||row.committed!==committed)throw Error('Archive snapshot missing');
 const snapshot=JSON.parse(row.state);if(snapshot.version!==1||snapshot.checksum!==hash(JSON.stringify(snapshot.state)))throw Error('Archive state checksum mismatch');
 if(canonical({...snapshot.state,retirement:undefined})!==canonical({...pending.state,retirement:undefined}))throw Error('Archive snapshot revision mismatch');
 const sources=new Map(pending.sources.map(s=>[s.physical,s]));let segments=0;
 for(const s of d.prepare('SELECT id,total FROM segments WHERE owner=?').iterate(id)){segments++;let expected=0;const digest=createHash('sha256');const source=sources.get(s.id);if(!source)throw Error('Archive segment corruption');for(const b of d.prepare('SELECT * FROM blocks WHERE physical=? ORDER BY start').iterate(s.id)){if(b.start!==expected)throw Error('Archive block gap corruption');for(const r of decode(b))digest.update(canonical(r)+'\n');expected+=b.count;}if(expected!==s.total||expected!==source.count||digest.digest('hex')!==source.hash)throw Error('Archive source verification failed');}
 if(segments!==sources.size)throw Error('Archive missing segment corruption');
}
function run(op,a){const d=database(op==='begin');if(!d&&op==='verify')throw Error('Archive snapshot missing');if(!d)return ['pending','references'].includes(op)?[]:op==='query'?{items:[]}:op==='has'?false:null;
 if(op==='begin'){d.prepare('INSERT INTO archives(id,project,at,state) VALUES(?,?,?,?)').run(a.state.sessionId,a.state.projectId||null,a.at,JSON.stringify({version:1,state:a.state,checksum:hash(JSON.stringify(a.state))}));return;}
 if(op==='segment'){d.prepare('INSERT INTO segments(id,owner) VALUES(?,?)').run(a.physical,a.owner);return;}
 if(op==='block'){const b=Buffer.from(JSON.stringify(a.records));if(b.length>16777216)throw Error('Archive block exceeds limit');d.prepare('INSERT INTO blocks VALUES(?,?,?,?,?,?)').run(a.physical,a.start,a.records.length,b.length,hash(b),gzipSync(b));d.prepare('UPDATE segments SET total=total+? WHERE id=?').run(a.records.length,a.physical);return;}
 if(op==='commit'){
 verify(d,a.id,a.pending,0);
 d.exec('BEGIN IMMEDIATE');try{if(a.reference)d.prepare('INSERT OR IGNORE INTO resources VALUES(?,?,?)').run(a.reference.projectId,a.reference.folderId||'',a.reference.workdir?JSON.stringify(a.reference.workdir):'');d.prepare('UPDATE archives SET committed=1,summary=?,pending=? WHERE id=?').run(JSON.stringify(a.summary),JSON.stringify(a.pending),a.id);d.exec('COMMIT');}catch(e){d.exec('ROLLBACK');throw e;}return;}
 if(op==='verify'){verify(d,a.id,a.pending,1);return;}
 if(op==='abort'){d.exec('BEGIN IMMEDIATE');try{if(!d.prepare('SELECT 1 FROM archives WHERE id=? AND committed=1').get(a.id)){d.prepare('DELETE FROM blocks WHERE physical IN(SELECT id FROM segments WHERE owner=?)').run(a.id);d.prepare('DELETE FROM segments WHERE owner=?').run(a.id);d.prepare('DELETE FROM archives WHERE id=?').run(a.id);}d.exec('COMMIT');}catch(e){d.exec('ROLLBACK');throw e;}return;}
 if(op==='references')return d.prepare('SELECT project,folder,workdir FROM resources').all().map(r=>({projectId:r.project,...(r.folder?{folderId:r.folder}:{}),...(r.workdir?{workdir:JSON.parse(r.workdir)}:{})}));
 if(op==='has')return !!d.prepare('SELECT 1 FROM archives WHERE id=? AND committed=1 UNION SELECT 1 FROM segments s JOIN archives a ON a.id=s.owner WHERE s.id=? AND a.committed=1').get(a.id,a.id);
 if(op==='state'){const r=d.prepare('SELECT state FROM archives WHERE id=? AND committed=1').get(a.id);if(!r)return null;const v=JSON.parse(r.state);if(v.version!==1)throw Error('Unsupported archive state');if(v.checksum!==hash(JSON.stringify(v.state)))throw Error('Archive state checksum mismatch');return v.state;}
 if(op==='pending')return d.prepare('SELECT id,pending FROM archives WHERE committed=1 AND pending IS NOT NULL ORDER BY id LIMIT 16').all().map(r=>({id:r.id,...JSON.parse(r.pending)}));
 if(op==='done'){d.prepare('UPDATE archives SET pending=NULL WHERE id=?').run(a.id);return;}
 if(op==='range'){
 const s=d.prepare('SELECT total FROM segments s JOIN archives a ON a.id=s.owner WHERE s.id=? AND a.committed=1').get(a.id);if(!s)return null;
 if(a.offset>=s.total)return {records:[],total:s.total};
 const records=[];let bytes=0,expected=a.offset,budget=false;const target=Math.min(s.total,a.offset+a.limit);
 const lower=d.prepare('SELECT start FROM blocks WHERE physical=? AND start<=? ORDER BY start DESC LIMIT 1').get(a.id,a.offset)?.start??a.offset;
 outer:for(const b of d.prepare('SELECT * FROM blocks WHERE physical=? AND start>=? AND start<? ORDER BY start').iterate(a.id,lower,target)){
  if(b.start>expected||b.start+b.count<=expected)throw Error('Archive block gap corruption');
  const decoded=decode(b);for(const r of decoded.slice(expected-b.start,target-b.start)){const size=Buffer.byteLength(JSON.stringify(r))+1;if(records.length&&bytes+size>16777216){budget=true;break outer;}records.push(r);bytes+=size;expected++;}
 }
 if(!budget&&expected<target)throw Error('Archive missing block corruption');
 return {records,total:s.total,...(expected<s.total?{nextOffset:expected}:{})};}

 if(op==='query'){const rows=a.projectId===undefined?d.prepare(pageQueries.all).all(a.at,a.id,a.limit+1):d.prepare(pageQueries.project).all(a.projectId,a.at,a.id,a.limit+1);const more=rows.length>a.limit;rows.length=Math.min(rows.length,a.limit);const last=rows.at(-1);return {items:rows.map(r=>JSON.parse(r.summary)),...(more?{nextCursor:Buffer.from(JSON.stringify([last.at,last.id])).toString('base64url')}:{})};}
 throw Error('Unknown archive operation');}
parentPort.on('message',({id,op,args})=>{if(op==='close'){const closed=new Int32Array(args.closed);try{if(db){db.close();db=undefined;}Atomics.store(closed,0,1);}catch{Atomics.store(closed,0,2);}finally{Atomics.notify(closed,0);}return;}try{parentPort.postMessage({id,result:run(op,args)});}catch(e){parentPort.postMessage({id,error:e.message});}});
`
