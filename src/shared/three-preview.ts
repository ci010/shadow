export interface ThreePreviewSettings {
  toneMapping?: 'none' | 'aces'
  exposure?: number
}

/** JSON wire validator shared by the snapshot reader and client. */
export function isThreePreviewSettings(value: unknown): value is ThreePreviewSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, setting]) => {
    if (key === 'toneMapping') return setting === 'none' || setting === 'aces'
    if (key === 'exposure') return typeof setting === 'number' && Number.isFinite(setting) && setting >= 0.1 && setting <= 4
    return false
  })
}
