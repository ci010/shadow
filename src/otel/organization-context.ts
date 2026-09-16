import { context, createContextKey, trace, type Context } from '@opentelemetry/api'
import type { OrganizationScope } from '../organizations/scope.ts'

const organizationContextKey = createContextKey('shadow.organization-runtime')

export function getOrganizationTelemetryScope(parent: Context = context.active()): OrganizationScope | undefined {
  return parent.getValue(organizationContextKey) as OrganizationScope | undefined
}

export function runWithOrganizationTelemetry<T>(
  scope: OrganizationScope,
  sameScope: boolean,
  callback: () => T,
): T {
  const parent = sameScope ? context.active() : trace.deleteSpan(context.active())
  return context.with(parent.setValue(organizationContextKey, scope), callback)
}

export function captureOrganizationTelemetry(): <T>(callback: () => T) => T {
  const captured = context.active()
  return callback => context.with(captured, callback)
}
