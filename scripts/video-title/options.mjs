import path from 'node:path';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
export function localPath(value) {
  if (!value || /[\x00-\x1f\x7f]/u.test(value) || /^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(value.replace(/^[a-z]:[\\/]/i, '/')) || /[\\]/.test(value) && process.platform !== 'win32') throw new Error('Expected local path, not URI/network/device path');
  const resolved = path.resolve(value);
  if (/^(?:[a-z]:)?[\\/](?:dev|proc|sys)(?:[\\/]|$)/i.test(resolved) || resolved.split(/[\\/]/).some(p => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) || resolved.slice(process.platform === 'win32' ? 2 : 0).includes(':')) throw new Error('Device/stream path forbidden');
  return resolved;
}
export function parseArgs(args) {
  const allowed = new Set(['text-file','font','output','width','height','font-size','align','color','padding','timeout']);
  const o = { align: 'center', color: '#FFFFFF', padding: '32', timeout: '30' }, seen = new Set();
  for (let i=0;i<args.length;i+=2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.has(key) || seen.has(key) || args[i+1] === undefined) throw new Error('Unknown, duplicate or missing argument');
    seen.add(key); o[key] = args[i+1];
  }
  for (const key of ['text-file','font','output','width','height','font-size']) if (!seen.has(key)) throw new Error(`Required --${key}`);
  for (const [key,min,max] of [['width',1,8192],['height',1,8192],['font-size',1,1024],['padding',0,4096],['timeout',1,300]]) {
    if (!/^\d+$/.test(o[key]) || !Number.isSafeInteger(Number(o[key])) || +o[key]<min || +o[key]>max) throw new Error(`Invalid integer --${key}`);
    o[key]=Number(o[key]);
  }
  if (o.width*o.height>16777216 || o.padding*2>=Math.min(o.width,o.height)) throw new Error('Canvas/padding limit');
  if (!['left','center','right'].includes(o.align) || !/^#[\da-f]{6}$/i.test(o.color)) throw new Error('Invalid align/color');
  for (const key of ['text-file','font','output']) o[key]=localPath(o[key]);
  if (!/\.png$/i.test(o.output) || !/\.(?:ttf|otf)$/i.test(o.font)) throw new Error('Expected .png output and .ttf/.otf font');
  return o;
}
export async function boundedFile(file, limit) {
  localPath(await realpath(file));
  const h = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.size>limit) throw new Error('Expected bounded regular file');
    const b=Buffer.alloc(limit+1); let size=0;
    while(size<b.length) { const {bytesRead}=await h.read(b,size,b.length-size,null); if(!bytesRead) break; size+=bytesRead; }
    if(size>limit) throw new Error('File size limit');
    return b.subarray(0,size);
  } finally { await h.close(); }
}
export function decodeText(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n/g,'\n');
  if (!text.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/\n/g,'')) || [...text].length>4096 || text.split('\n').length>64) throw new Error('Text must be plain UTF-8, max 4096 characters / 64 lines, no controls except LF');
  return text;
}
