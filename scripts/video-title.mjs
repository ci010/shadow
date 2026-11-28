// Source-checkout-only helper. Uses the existing desktop Electron installation.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, realpath, link, rm } from 'node:fs/promises';
import { parseArgs, boundedFile, decodeText, localPath } from './video-title/options.mjs';
import { waitForChild } from './video-title/lifecycle.mjs';
export async function generate(args) {
  const o=parseArgs(args);
  const textBytes=await boundedFile(o['text-file'],16384), text=decodeText(textBytes);
  const font=await boundedFile(o.font,33554432);
  if(!['00010000','4f54544f','74727565'].includes(font.subarray(0,4).toString('hex'))) throw new Error('Invalid TTF/OTF signature');
  const parent=localPath(await realpath(path.dirname(o.output))); o.output=path.join(parent,path.basename(o.output));
  try { await lstat(o.output); throw new Error('Output already exists'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const root=await mkdtemp(path.join(parent,'.video-title-'));
  try {
    await writeFile(path.join(root,'input.json'),JSON.stringify({...o,text,fontBase64:font.toString('base64')}),{mode:0o600,flag:'wx'});
    const require=createRequire(new URL('../desktop/package.json',import.meta.url));
    const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(require('electron'),[fileURLToPath(new URL('./video-title/electron.cjs',import.meta.url)),root],{env,stdio:['ignore','ignore','pipe']});
    let stderr=''; child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);});
    const code=await waitForChild(child,o.timeout*1000);
    if(code!==0) throw new Error(`Electron rendering failed (${code}): ${stderr}`);
    const result=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));
    const png=await readFile(path.join(root,'image.png'));
    if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || png.readUInt32BE(16)!==o.width || png.readUInt32BE(20)!==o.height) throw new Error('Invalid rendered PNG');
    // Same-filesystem hard link publishes atomically, and fails if any entry exists.
    await link(path.join(root,'image.png'),o.output);
    const sha=b=>createHash('sha256').update(b).digest('hex');
    const provenance={schema:'shadow.video-title.v1',helper:'source-checkout-electron-canvas',fontSha256:sha(font),textSha256:sha(textBytes),rendererVersion:result.rendererVersion,layout:result.layout,color:o.color,width:o.width,height:o.height,warnings:['font-coverage-not-verified']};
    return {file:o.output,width:o.width,height:o.height,...result,fontSha256:provenance.fontSha256,textSha256:provenance.textSha256,warnings:provenance.warnings,titleProvenance:provenance};
  } finally { await rm(root,{recursive:true,force:true}); }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) generate(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
