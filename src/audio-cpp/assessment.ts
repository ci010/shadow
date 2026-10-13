import { cpus, freemem, totalmem } from 'node:os'
import { statfs } from 'node:fs/promises'
import { z } from 'zod'

export const candidateSchema = z.object({
  family: z.string().min(1), backend: z.enum(['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best']).default('cpu'),
  downloadBytes: z.number().int().positive().safe(),
  minimumMemoryBytes: z.number().int().positive().safe().optional(),
  memoryEvidence: z.string().url().optional(),
  platform: z.enum(['win32', 'linux', 'darwin']), arch: z.enum(['x64', 'arm64']),
}).strict().refine(c => !c.minimumMemoryBytes || !!c.memoryEvidence, 'Memory requirements need published evidence')
export type Candidate = z.input<typeof candidateSchema>
export interface Hardware { platform: string; arch: string; cpuCount: number; totalMemoryBytes: number; availableMemoryBytes: number; freeDiskBytes: number }
export async function detectHardware(directory: string): Promise<Hardware> {
  const disk = await statfs(directory)
  return { platform: process.platform, arch: process.arch, cpuCount: cpus().length, totalMemoryBytes: totalmem(), availableMemoryBytes: freemem(), freeDiskBytes: disk.bavail * disk.bsize }
}
export function assessCandidate(request: Candidate, hardware: Hardware) {
  const candidate = candidateSchema.parse(request)
  const reasons: string[] = []
  let suitability: 'suitable' | 'unsuitable' | 'unknown' = 'unknown'
  if (candidate.platform !== hardware.platform || candidate.arch !== hardware.arch) reasons.push('Package OS/architecture does not match this host')
  if (candidate.downloadBytes > hardware.freeDiskBytes) reasons.push('Insufficient measured free disk for downloads (extraction needs additional space)')
  if (candidate.minimumMemoryBytes && candidate.minimumMemoryBytes > hardware.availableMemoryBytes) reasons.push('Published model memory requirement exceeds measured available RAM')
  if (reasons.length) suitability = 'unsuitable'
  else if (candidate.backend !== 'cpu') reasons.push('GPU driver, backend build and device memory have not been verified; use a CLI device/inference probe')
  else if (!candidate.minimumMemoryBytes) reasons.push('No evidenced model-specific memory requirement; model size alone cannot establish RAM needs')
  else { suitability = 'suitable'; reasons.push('CPU package matches host and basic published RAM/download capacity checks pass; extraction space and actual inference still need verification') }
  return { suitability, recommendRemote: suitability === 'unsuitable', reasons, candidate, hardware, inferenceVerified: false }
}
