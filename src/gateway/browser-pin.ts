import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/** Read only at process startup; never send or persist the plaintext PIN elsewhere. */
export async function loadBrowserPinHash(path: string): Promise<string | undefined> {
  let file
  try { file = await open(path, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Could not read the browser PIN file. Check its permissions before starting Shadow.')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 512) throw new Error('Invalid browser PIN file.')
    const pin = (await file.readFile('utf8')).trim()
    if (pin.length < 4 || pin.length > 128 || /[\r\n\0]/.test(pin)) {
      throw new Error('Browser PIN must contain 4 to 128 characters on one line.')
    }
    return createHash('sha256').update(pin).digest('hex')
  } finally { await file.close() }
}
