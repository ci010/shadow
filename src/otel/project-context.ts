import { context, createContextKey, trace, type Context } from '@opentelemetry/api'
import type { ProjectScope } from '../projects/scope.ts'

const projectContextKey = createContextKey('shadow.project-runtime')

export function getProjectTelemetryScope(parent: Context = context.active()): ProjectScope | undefined {
  return parent.getValue(projectContextKey) as ProjectScope | undefined
}

export function runWithProjectTelemetry<T>(
  scope: ProjectScope,
  sameScope: boolean,
  callback: () => T,
): T {
  const parent = sameScope ? context.active() : trace.deleteSpan(context.active())
  return context.with(parent.setValue(projectContextKey, scope), callback)
}

export function captureProjectTelemetry(): <T>(callback: () => T) => T {
  const captured = context.active()
  return callback => context.with(captured, callback)
}
