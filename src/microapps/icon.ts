import { MAX_ICON_BYTES, MicroAppError, type AppBundle } from './contracts.ts'

export function appIcon(bundle: AppBundle): Buffer | undefined {
  if (!bundle.manifest.icon) return undefined
  const bytes = Buffer.from(bundle.files[bundle.manifest.icon] ?? '', 'base64')
  if (bytes.length < 33 || bytes.length > MAX_ICON_BYTES
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 512
    || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 512) {
    throw new MicroAppError('invalid_icon', 'Use a PNG app icon up to 512 × 512 pixels and 256 KiB')
  }
  return bytes
}
