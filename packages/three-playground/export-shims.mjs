class AbortController {
  signal = { aborted: false };
  abort() { this.signal.aborted = true; }
}
// Only the binary exporter uses these lexical shims; they are not host bridges.
class TextEncoder {
  encode(text) {
    const bytes = [];
    for (const char of text) {
      let cp = char.codePointAt(0);
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      if (cp < 128) bytes.push(cp);
      else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
      else if (cp < 65536) bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
      else bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
    }
    return Uint8Array.from(bytes);
  }
}
class Blob {
  constructor(parts) {
    const views = parts.map(part => ArrayBuffer.isView(part)
      ? new Uint8Array(part.buffer, part.byteOffset, part.byteLength) : new Uint8Array(part));
    const size = views.reduce((n, view) => n + view.length, 0);
    if (size > 16 * 1024 * 1024) throw new Error('GLB exceeds 16 MiB');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const view of views) { bytes.set(view, offset); offset += view.length; }
    this.buffer = bytes.buffer;
    this.size = size;
  }
}
class FileReader {
  // Exporter registers onloadend immediately after readAsArrayBuffer.
  readAsArrayBuffer(blob) { this.result = blob.buffer; }
  set onloadend(callback) { callback(); }
}

export { AbortController, Blob, FileReader, TextEncoder };
