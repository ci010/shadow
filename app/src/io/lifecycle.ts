import { t } from '../i18n.ts'
import { IO_FINALIZE_MS } from '../../../src/io/contracts.ts'

export async function withinIoFinalization<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(t('Finalization exceeded its 5-second drain allowance. Partial artifacts were retained.'))), IO_FINALIZE_MS)
  })
  try { return await Promise.race([work(), deadline]) }
  finally { clearTimeout(timer) }
}
