import SevenZip from '7z-wasm'
import { crc32 } from 'node:zlib'

function rarHeader(type: number, flags: number, data: Buffer): Buffer {
  const header = Buffer.alloc(7 + data.length)
  header[2] = type
  header.writeUInt16LE(flags, 3)
  header.writeUInt16LE(header.length, 5)
  data.copy(header, 7)
  header.writeUInt16LE(crc32(header.subarray(2)) & 0xffff, 0)
  return header
}

export function rarFixture(): Buffer {
  const name = Buffer.from('notes.txt')
  const text = Buffer.from('Synthetic archive entry')
  const fields = Buffer.alloc(25 + name.length)
  fields.writeUInt32LE(text.length, 0)
  fields.writeUInt32LE(text.length, 4)
  fields[8] = 3
  fields.writeUInt32LE(crc32(text), 9)
  fields[17] = 20
  fields[18] = 0x30
  fields.writeUInt16LE(name.length, 19)
  fields.writeUInt32LE(0o100644, 21)
  name.copy(fields, 25)
  return Buffer.concat([Buffer.from('526172211a0700', 'hex'), rarHeader(0x73, 0, Buffer.alloc(6)),
    rarHeader(0x74, 0x8000, fields), text, rarHeader(0x7b, 0, Buffer.alloc(0))])
}

export function rar5Fixture(): Buffer {
  const text = Buffer.from('Synthetic archive entry')
  const name = Buffer.from('notes.txt')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32LE(crc32(text))
  const header = (body: Buffer) => {
    const data = Buffer.concat([Buffer.from([body.length]), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32LE(crc32(data))
    return Buffer.concat([crc, data])
  }
  return Buffer.concat([Buffer.from('526172211a070100', 'hex'),
    header(Buffer.from([1, 0, 0])),
    header(Buffer.concat([Buffer.from([2, 2, text.length, 4, text.length, 0x20]), checksum, Buffer.from([0, 0, name.length]), name])),
    text, header(Buffer.from([5, 0, 0]))])
}

export async function archiveFixtures(): Promise<Map<string, Buffer>> {
  const module = await SevenZip({ print() {}, printErr() {}, stdin: () => -1 })
  const fixtures = new Map<string, Buffer>()
  module.FS.mkdir('/source')
  module.FS.mkdir('/source/folder')
  module.FS.mkdir('/source/empty')
  module.FS.writeFile('/source/notes.txt', 'Synthetic archive entry')
  module.FS.writeFile('/source/folder/deep.txt', 'Nested archive entry')
  module.FS.writeFile('/source/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#245bc1"/></svg>')
  module.FS.writeFile('/source/large.txt', `<script>window.unsafeArchiveEntry = true</script>\n${'x'.repeat(70000)}`)
  module.FS.writeFile('/source/page.html', '<script>window.unsafeArchiveEntry = true</script>')
  module.FS.writeFile('/source/literal[1].txt', 'Exact entry')
  module.FS.chdir('/source')
  for (const format of ['zip', '7z', 'tar']) {
    module.callMain(['a', `-t${format}`, `/bundle.${format}`, '.', '-bso0', '-bsp0'])
    fixtures.set(`bundle.${format}`, Buffer.from(module.FS.readFile(`/bundle.${format}`)))
  }
  for (const [format, suffix] of [['gzip', 'gz'], ['bzip2', 'bz2'], ['xz', 'xz']]) {
    module.callMain(['a', `-t${format}`, `/bundle.tar.${suffix}`, '/bundle.tar', '-bso0', '-bsp0'])
    fixtures.set(`bundle.tar.${suffix}`, Buffer.from(module.FS.readFile(`/bundle.tar.${suffix}`)))
    module.callMain(['a', `-t${format}`, `/notes.txt.${suffix}`, '/source/notes.txt', '-bso0', '-bsp0'])
    fixtures.set(`notes.txt.${suffix}`, Buffer.from(module.FS.readFile(`/notes.txt.${suffix}`)))
  }
  module.callMain(['a', '-tzip', '/nested.zip', '/bundle.7z', '-bso0', '-bsp0'])
  fixtures.set('nested.zip', Buffer.from(module.FS.readFile('/nested.zip')))
  module.callMain(['a', '-t7z', '-psecret', '/encrypted.7z', '/source/notes.txt', '-bso0', '-bsp0'])
  fixtures.set('encrypted.7z', Buffer.from(module.FS.readFile('/encrypted.7z')))
  fixtures.set('bundle.rar', rarFixture())
  fixtures.set('empty.zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
  return fixtures
}
