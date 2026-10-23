import { crc32, deflateSync } from 'node:zlib'

/** Real PNG bytes, including CRCs, for media transport tests without external fixtures. */
export function pngFixture(width = 1, height = 1): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([size, type, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  let seed = 1
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      rows[y * (width * 3 + 1) + x] = seed & 255
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ])
}
