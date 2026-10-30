import { normalizeStoredWorkdirIdentity } from '../execution/workdir-storage.ts'
import { isAbsolute } from 'node:path'

export type InstallationMode = 'main' | 'child'

interface BootstrapConfigBaseV1 {
  version: 1
  dataDir: string
  localNodeId: string
}

export interface MainBootstrapConfigV1 extends BootstrapConfigBaseV1 {
  mode: 'main'
}

export interface ChildBootstrapConfigV1 extends BootstrapConfigBaseV1 {
  mode: 'child'
  mainEndpoint: string
  allowInsecureLocalTransport?: boolean
  workdirs?: ChildWorkdirBinding[]
}

export interface ChildWorkdirBinding {
  workdirId: string
  rootPath: string
  displayName: string
}

export type BootstrapConfigV1 = MainBootstrapConfigV1 | ChildBootstrapConfigV1

const BOOTSTRAP_FIELDS = new Set([
  'version',
  'mode',
  'dataDir',
  'localNodeId',
  'mainEndpoint',
  'allowInsecureLocalTransport',
  'workdirs',
])

export class BootstrapConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid bootstrap configuration:\n- ${issues.join('\n- ')}`)
    this.name = 'BootstrapConfigError'
  }
}

export function parseBootstrapConfigV1(input: unknown): BootstrapConfigV1 {
  if (!isRecord(input)) {
    throw new BootstrapConfigError(['configuration must be a JSON object'])
  }

  const issues: string[] = []
  for (const field of Object.keys(input)) {
    if (!BOOTSTRAP_FIELDS.has(field)) issues.push(`unknown field "${field}"`)
  }

  if (input.version !== 1) issues.push('version must be 1')
  if (input.mode !== 'main' && input.mode !== 'child') {
    issues.push('mode must be "main" or "child"')
  }

  const dataDir = readNonEmptyString(input, 'dataDir', issues)
  const localNodeId = readNonEmptyString(input, 'localNodeId', issues)
  const mode = input.mode

  if (mode === 'main' && input.mainEndpoint !== undefined) {
    issues.push('mainEndpoint is only valid when mode is "child"')
  }
  if (mode === 'main' && input.allowInsecureLocalTransport !== undefined) {
    issues.push(
      'allowInsecureLocalTransport is only valid when mode is "child"',
    )
  }
  if (mode === 'main' && input.workdirs !== undefined) {
    issues.push('workdirs is only valid when mode is "child"')
  }

  let mainEndpoint: string | undefined
  let workdirs: ChildWorkdirBinding[] | undefined
  if (mode === 'child') {
    const rawEndpoint = readNonEmptyString(input, 'mainEndpoint', issues)
    if (rawEndpoint !== undefined) {
      mainEndpoint = normalizeMainEndpoint(rawEndpoint, issues)
    }
    if (
      input.allowInsecureLocalTransport !== undefined &&
      typeof input.allowInsecureLocalTransport !== 'boolean'
    ) {
      issues.push('allowInsecureLocalTransport must be a boolean')
    }
    if (input.workdirs !== undefined) {
      workdirs = readWorkdirs(input.workdirs, issues)
    }
  }

  if (issues.length > 0 || dataDir === undefined || localNodeId === undefined) {
    throw new BootstrapConfigError(issues)
  }

  const base = { version: 1 as const, dataDir, localNodeId }
  if (mode === 'child' && mainEndpoint !== undefined) {
    return {
      ...base,
      mode,
      mainEndpoint,
      ...(typeof input.allowInsecureLocalTransport !== 'boolean' ? {} : {
        allowInsecureLocalTransport: input.allowInsecureLocalTransport,
      }),
      ...(workdirs === undefined ? {} : { workdirs }),
    }
  }
  return { ...base, mode: 'main' }
}

function readWorkdirs(
  value: unknown,
  issues: string[],
): ChildWorkdirBinding[] | undefined {
  if (!Array.isArray(value)) {
    issues.push('workdirs must be an array')
    return undefined
  }
  const result: ChildWorkdirBinding[] = []
  const workdirIds = new Set<string>()
  for (const [index, saved] of value.entries()) {
    const prefix = `workdirs[${index}]`
    // Only the persisted bootstrap reader knows the retired capability address.
    const item = normalizeStoredWorkdirIdentity(saved)
    if (!isRecord(item)) {
      issues.push(`${prefix} must be a JSON object`)
      continue
    }
    for (const field of Object.keys(item)) {
      if (!['workdirId', 'rootPath', 'displayName'].includes(field)) {
        issues.push(`${prefix} has unknown field "${field}"`)
      }
    }
    const workdirId = readNestedString(item, 'workdirId', prefix, issues)
    const rootPath = readNestedString(item, 'rootPath', prefix, issues)
    const displayName = readNestedString(item, 'displayName', prefix, issues)
    if (workdirId !== undefined) {
      if (workdirId === 'process-execute') {
        issues.push(`${prefix}.workdirId is reserved`)
      } else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workdirId)) {
        issues.push(`${prefix}.workdirId is invalid`)
      } else if (workdirIds.has(workdirId)) {
        issues.push(`${prefix}.workdirId must be unique`)
      } else {
        workdirIds.add(workdirId)
      }
    }
    if (rootPath !== undefined && !isAbsolute(rootPath)) {
      issues.push(`${prefix}.rootPath must be absolute`)
    }
    if (
      workdirId !== undefined && rootPath !== undefined &&
      displayName !== undefined && isAbsolute(rootPath) &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workdirId) &&
      workdirId !== 'process-execute' &&
      workdirIds.has(workdirId) &&
      !result.some((entry) => entry.workdirId === workdirId)
    ) {
      result.push({ workdirId, rootPath, displayName })
    }
  }
  return result
}

function readNestedString(
  input: Record<string, unknown>,
  field: string,
  prefix: string,
  issues: string[],
): string | undefined {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${prefix}.${field} must be a non-empty string`)
    return undefined
  }
  return value.trim()
}

function readNonEmptyString(
  input: Record<string, unknown>,
  field: string,
  issues: string[],
): string | undefined {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${field} must be a non-empty string`)
    return undefined
  }
  return value.trim()
}

function normalizeMainEndpoint(
  value: string,
  issues: string[],
): string | undefined {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    issues.push('mainEndpoint must be an absolute http(s) URL')
    return undefined
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    issues.push('mainEndpoint must use http or https')
    return undefined
  }
  if (endpoint.username || endpoint.password) {
    issues.push('mainEndpoint must not contain credentials')
  }
  if (endpoint.search || endpoint.hash) {
    issues.push('mainEndpoint must not contain a query or fragment')
  }

  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  return endpoint.toString().replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
