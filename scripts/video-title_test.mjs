import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { parseArgs, decodeText, localPath, boundedFile } from './video-title/options.mjs';
import { generate } from './video-title.mjs';
import { waitForChild } from './video-title/lifecycle.mjs';
const base=['--text-file','caption.txt','--font','font.ttf','--output','title.png','--width','640','--height','360','--font-size','32'];
const fontCandidates=process.platform==='win32'?[path.join(process.env.WINDIR??'C:\\Windows','Fonts','arial.ttf'),path.join(process.env.WINDIR??'C:\\Windows','Fonts','segoeui.ttf')]:process.platform==='darwin'?['/System/Library/Fonts/Supplemental/Arial.ttf','/System/Library/Fonts/Supplemental/Verdana.ttf']:['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
async function installedFont(){for(const f of fontCandidates)try{await access(f);return f;}catch{} throw new Error('No installed test font; checked '+fontCandidates.join(', '));}
test('strict args and plain text',()=>{
  assert.equal(parseArgs(base).align,'center');
  assert.equal(decodeText(Buffer.from('Title\r\nSubtitle')), 'Title\nSubtitle');
  for(const a of [['--wat','1'],['--width','32'],['--timeout','1.2'],['--padding','-1'],['--color','white;alert(1)'],['--align','center; touch pwn'],['--height','99999']]) assert.throws(()=>parseArgs([...base,...a]));
  for (const [key,value] of [['width','1.5'],['height','0'],['font-size','9999'],['width','Infinity'],['height','1e3']]) {
    const args=[...base]; args[args.indexOf('--'+key)+1]=value; assert.throws(()=>parseArgs(args));
  }
  assert.throws(()=>parseArgs(base.slice(2)));
  assert.throws(()=>parseArgs([...base,'--timeout']));
  for(const p of ['https://x/font.ttf','file:///tmp/x','//host/share','\\\\host\\share','/dev/null','NUL','caption.txt:evil']) assert.throws(()=>localPath(p));
  for(const b of [Buffer.from([0xff]),Buffer.from('x\0y'),Buffer.from('x\ry'),Buffer.from('x\ty'),Buffer.from('\u202ex'),Buffer.from('x\n'.repeat(65))]) assert.throws(()=>decodeText(b));
  assert.equal(decodeText(Buffer.from('<script>"${alert(1)}\n&')),'<script>"${alert(1)}\n&');
});
// Decode Chromium's RGBA PNG scanlines, including all PNG filter modes.
function pngPixels(b){
  assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const w=b.readUInt32BE(16),h=b.readUInt32BE(20); assert.equal(b[24],8);assert.equal(b[25],6);
  const chunks=[];for(let i=8;i<b.length;){const n=b.readUInt32BE(i);if(b.toString('ascii',i+4,i+8)==='IDAT')chunks.push(b.subarray(i+8,i+8+n));i+=12+n;}
  const raw=inflateSync(Buffer.concat(chunks)),stride=w*4,out=Buffer.alloc(h*stride);let at=0;
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<h;y++){const f=raw[at++];assert.ok(f<=4);for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=4?out[i-4]:0,b=y?out[i-stride]:0,c=y&&x>=4?out[i-stride-4]:0;out[i]=(raw[at++]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][f])&255;}}
  return {w,h,out};
}
test('real sandbox Electron PNG, special paths, no-clobber, invalid files and overflow',async()=>{
  const root=await mkdtemp(path.resolve('.video-title-test-'));
  try{
    const font=await installedFont(),text=path.join(root,"caption ' $ &.txt"),output=path.join(root,"title ' $ &.png");
    await writeFile(text,'Title <script> & "\nSubtitle');
    const args=['--text-file',text,'--font',font,'--output',output,'--width','640','--height','360','--font-size','32'];
    const result=await generate(args);assert.equal(result.titleProvenance.schema,'shadow.video-title.v1');assert.equal(result.fontSha256.length,64);assert.deepEqual(result.warnings,['font-coverage-not-verified']);
    const original=await readFile(output),{w,h,out}=pngPixels(original);assert.equal(w,640);assert.equal(h,360);
    let ink=0,clear=0;for(let i=3;i<out.length;i+=4){if(out[i])ink++;else clear++;}assert.ok(ink>0&&clear>0);assert.equal(out[3],0);
    await assert.rejects(generate(args),/exists/);assert.deepEqual(await readFile(output),original);
    await assert.rejects(generate(args.map(v=>v===font?path.join(root,'missing.ttf'):v)),/ENOENT/);
    await writeFile(text,Buffer.from([0xff]));await assert.rejects(generate(args),/encoded|encoding/i);
    await writeFile(text,'W'.repeat(200));await assert.rejects(generate(args.map(v=>v===output?path.join(root,'overflow.png'):v)),/overflow/);
    await assert.rejects(boundedFile(text,2),/bounded|limit/);
    await assert.rejects(boundedFile(root,16384),/regular/);
    const badFont=path.join(root,'bad.ttf'); await writeFile(badFont,'not a font');
    await assert.rejects(generate(args.map(v=>v===font?badFont:v)),/signature/);
    await writeFile(text,Buffer.alloc(16385,65)); await assert.rejects(generate(args),/bounded|limit/);
    assert.deepEqual((await readdir(root)).filter(n=>n.startsWith('.video-title-')),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('timeout and SIGINT/SIGTERM cancellation await close and remove listeners',async()=>{
  for(const signal of [null,'SIGINT','SIGTERM']){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');
    let closed=false; child.once('close',()=>{closed=true;});
    const before=process.listenerCount('SIGINT');
    const done=waitForChild(child,signal?10000:20,100);
    if(signal)process.emit(signal);
    await assert.rejects(done,signal?/cancelled/:/timeout/);assert.equal(closed,true);assert.equal(process.listenerCount('SIGINT'),before);
  }
});
