export interface ReleaseReadiness {
  type: 'shadow:release-ready'
  buildId: string
  sourceHash: string
  pid: number
  executablePath: string
  state: 'setup-required' | 'ready' | 'failed'
  role: 'main' | 'child' | null
}

export async function desktopReleaseReadiness(
  manifest: unknown,
  identity: { pid: number; executablePath: string },
  bootstrap: { step: string; mode: 'main' | 'child' | null },
  ensureRuntime: () => Promise<{ ok: boolean }>,
): Promise<ReleaseReadiness> {
  if (!manifest || typeof manifest !== 'object' || !('buildId' in manifest) || typeof manifest.buildId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(manifest.buildId) || !('sourceHash' in manifest)
    || typeof manifest.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)) {
    throw new Error('Invalid packaged release identity')
  }
  const state = bootstrap.step === 'complete' || bootstrap.step === 'launch-main'
    ? (await ensureRuntime()).ok ? 'ready' : 'failed'
    : 'setup-required'
  return { type: 'shadow:release-ready', buildId: manifest.buildId, sourceHash: manifest.sourceHash,
    ...identity, state, role: bootstrap.mode }
}
