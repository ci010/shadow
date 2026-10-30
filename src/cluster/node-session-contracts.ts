import { validateExecutionSupport, validateWorkdirAdvertisement, type WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type {
  JobEventV1,
  JobRequestV2,
  ValidationResult,
} from '../execution/contracts.ts'
import {
  validateJobEventV1,
  validateJobRequestV2,
} from '../execution/contracts.ts'
import type {
  ExecutionSupport,
  DeviceCredentialId,
  DeviceId,
  NodeId,
  VersionHelloV1,
} from './contracts.ts'
import {
  isClusterIdentifier,
  validateVersionHelloV1,
} from './contracts.ts'
import type { NegotiatedVersionV1 } from './registry.ts'

export interface NodeSessionHelloV1 {
  protocolMajor: number
  protocolMinor: number
  implementationVersion: string
  features: string[]
}

interface InboundFrameBaseV1 {
  version: 1
  sequence: number
}

export type NodeSessionInboundFrameV1 =
  | (InboundFrameBaseV1 & { type: 'hello'; hello: NodeSessionHelloV1 })
  | (InboundFrameBaseV1 & {
    type: 'authenticate'
    authentication: {
      deviceId: DeviceId
      nodeId: NodeId
      credentialId: DeviceCredentialId
    }
  })
  | (InboundFrameBaseV1 & { type: 'workdir-advertise'; workdir: WorkdirAdvertisement })
  | (InboundFrameBaseV1 & { type: 'workdir-withdraw'; nodeId: NodeId; workdirId: string })
  | (InboundFrameBaseV1 & { type: 'node-support'; nodeId: NodeId; support: ExecutionSupport })
  | (InboundFrameBaseV1 & { type: 'job-event'; event: JobEventV1 })
  | (InboundFrameBaseV1 & { type: 'heartbeat'; sentAt: string })

interface OutboundFrameBaseV1 {
  version: 1
  sequence: number
}

export type NodeSessionOutboundFrameV1 =
  | (OutboundFrameBaseV1 & {
    type: 'authenticated'
    negotiated: NegotiatedVersionV1
  })
  | (OutboundFrameBaseV1 & { type: 'job-request'; request: JobRequestV2 })
  | (OutboundFrameBaseV1 & { type: 'job-cancel'; jobId: string })
  | (OutboundFrameBaseV1 & { type: 'heartbeat'; sentAt: string })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: string[],
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`unknown field: ${key}`)
  }
}

function validateSequence(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) {
    errors.push('sequence must be a non-negative safe integer')
  }
}

function validateTimestamp(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Number.isNaN(Date.parse(value))
  ) {
    errors.push(`${field} must be an ISO timestamp`)
  }
}

function validateSessionHello(
  value: unknown,
): ValidationResult<NodeSessionHelloV1> {
  if (!isRecord(value)) {
    return { success: false, errors: ['hello must be an object'] }
  }
  const errors: string[] = []
  hasOnlyKeys(
    value,
    ['protocolMajor', 'protocolMinor', 'implementationVersion', 'features'],
    errors,
  )
  if (
    !Number.isSafeInteger(value.protocolMajor) ||
    Number(value.protocolMajor) < 0
  ) {
    errors.push('protocolMajor must be a non-negative safe integer')
  }
  if (
    !Number.isSafeInteger(value.protocolMinor) ||
    Number(value.protocolMinor) < 0
  ) {
    errors.push('protocolMinor must be a non-negative safe integer')
  }
  if (
    typeof value.implementationVersion !== 'string' ||
    value.implementationVersion.length === 0
  ) {
    errors.push('implementationVersion must be a non-empty string')
  }
  if (
    !Array.isArray(value.features) ||
    value.features.some((feature) =>
      typeof feature !== 'string' || feature.length === 0
    ) ||
    new Set(value.features).size !== value.features.length
  ) errors.push('features must be an array of unique non-empty strings')
  return errors.length === 0
    ? { success: true, value: value as unknown as NodeSessionHelloV1 }
    : { success: false, errors }
}

export function validateNodeSessionInboundFrameV1(
  value: unknown,
): ValidationResult<NodeSessionInboundFrameV1> {
  if (!isRecord(value)) {
    return { success: false, errors: ['frame must be an object'] }
  }
  const errors: string[] = []
  if (value.version !== 1) errors.push('version must be 1')
  validateSequence(value, errors)

  if (value.type === 'hello') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'hello'], errors)
    const hello = validateSessionHello(value.hello)
    if (!hello.success) {
      errors.push(...hello.errors.map((error) => `hello.${error}`))
    }
  } else if (value.type === 'authenticate') {
    hasOnlyKeys(
      value,
      ['version', 'sequence', 'type', 'authentication'],
      errors,
    )
    if (!isRecord(value.authentication)) {
      errors.push('authentication must be an object')
    } else {
      hasOnlyKeys(
        value.authentication,
        ['deviceId', 'nodeId', 'credentialId'],
        errors,
      )
      for (const key of ['deviceId', 'nodeId', 'credentialId']) {
        if (!isClusterIdentifier(value.authentication[key])) {
          errors.push(`authentication.${key} must be a valid identifier`)
        }
      }
    }
  } else if (value.type === 'workdir-advertise') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'workdir'], errors)
    const parsed = validateWorkdirAdvertisement(value.workdir)
    if (!parsed.success) errors.push(...parsed.errors)
  } else if (value.type === 'workdir-withdraw') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'nodeId', 'workdirId'], errors)
    if (!isClusterIdentifier(value.nodeId) || !isClusterIdentifier(value.workdirId)) errors.push('invalid workdir identifiers')
  } else if (value.type === 'node-support') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'nodeId', 'support'], errors)
    if (!isClusterIdentifier(value.nodeId)) errors.push('nodeId is invalid')
    const support = validateExecutionSupport(value.support, 'node')
    if (!support.success) errors.push(...support.errors)
  } else if (value.type === 'job-event') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'event'], errors)
    const event = validateJobEventV1(value.event)
    if (!event.success) {
      errors.push(...event.errors.map((error) => `event.${error}`))
    }
  } else if (value.type === 'heartbeat') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'sentAt'], errors)
    validateTimestamp(value.sentAt, 'sentAt', errors)
  } else {
    errors.push('type is unsupported')
  }

  return errors.length === 0
    ? { success: true, value: value as unknown as NodeSessionInboundFrameV1 }
    : { success: false, errors }
}

export function validateNodeSessionOutboundFrameV1(
  value: unknown,
): ValidationResult<NodeSessionOutboundFrameV1> {
  if (!isRecord(value)) {
    return { success: false, errors: ['frame must be an object'] }
  }
  const errors: string[] = []
  if (value.version !== 1) errors.push('version must be 1')
  validateSequence(value, errors)
  if (value.type === 'authenticated') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'negotiated'], errors)
    if (!isRecord(value.negotiated)) {
      errors.push('negotiated must be an object')
    } else {
      const hello: VersionHelloV1 = {
        protocolMajor: value.negotiated.protocolMajor as 1,
        protocolMinor: value.negotiated.protocolMinor as number,
        implementationVersion: 'negotiated',
        features: value.negotiated.features as string[],
      }
      const validation = validateVersionHelloV1(hello)
      if (!validation.success) {
        errors.push(...validation.errors.map((error) => `negotiated.${error}`))
      }
      hasOnlyKeys(value.negotiated, [
        'protocolMajor',
        'protocolMinor',
        'features',
      ], errors)
    }
  } else if (value.type === 'job-request') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'request'], errors)
    const request = validateJobRequestV2(value.request)
    if (!request.success) {
      errors.push(...request.errors.map((error) => `request.${error}`))
    }
  } else if (value.type === 'job-cancel') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'jobId'], errors)
    if (typeof value.jobId !== 'string' || value.jobId.length === 0) {
      errors.push('jobId must be a non-empty string')
    }
  } else if (value.type === 'heartbeat') {
    hasOnlyKeys(value, ['version', 'sequence', 'type', 'sentAt'], errors)
    validateTimestamp(value.sentAt, 'sentAt', errors)
  } else {
    errors.push('type is unsupported')
  }
  return errors.length === 0
    ? { success: true, value: value as unknown as NodeSessionOutboundFrameV1 }
    : { success: false, errors }
}
