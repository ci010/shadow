import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'
import { ComputerError, type ComputerDesktop, type ComputerObservation, type DesktopRequest } from '../../execution/computer/contracts.ts'
import { ComputerService } from '../service.ts'

export const owner = { projectId: 'project-a', sessionId: 'web:fixture' }
export const bounds = { x: 10, y: 20, width: 400, height: 300 }
export const frame = {
  mime: 'image/png' as const, width: 1, height: 1,
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jELkAAAAASUVORK5CYII=',
}
export class FixtureDesktop implements ComputerDesktop {
  available = true
  generation = 0
  calls: DesktopRequest[] = []
  window = { id: randomUUID(), title: 'Synthetic fixture', app: 'fixture', pid: 42 }
  target = { ...this.window, id: randomUUID(), bounds }
  observation: ComputerObservation = {
    id: randomUUID(), targetId: this.target.id, title: this.window.title, bounds, truncated: false,
    elements: [{ id: '0', parentId: null, role: 'ControlType.Edit', name: 'Synthetic field',
      value: 'before', enabled: true, offscreen: false, protected: false, focusable: true, bounds, actions: ['set_value', 'invoke'] }],
  }
  failure?: ComputerError
  focusRestored?: boolean | null
  async request(request: DesktopRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    this.calls.push(structuredClone(request))
    if (this.failure) throw this.failure
    if (request.method === 'list') return { windows: [this.window], excluded: 0 }
    if (request.method === 'bind') return this.target
    if (request.method === 'observe') return structuredClone({ ...this.observation,
      screenshot: request.screenshot ? this.observation.screenshot : undefined })
    if (request.method === 'act') {
      this.observation = { ...this.observation, id: randomUUID(), screenshot: undefined }
      return { actionId: request.actionId, outcome: 'executed', verified: request.action.kind === 'set_value',
        observation: this.observation, focusRestored: this.focusRestored }
    }
    return { released: true }
  }
  async interrupt() { this.generation++ }
}
export async function fixture(t: TestContext, options: ConstructorParameters<typeof ComputerService>[1] = {}, foregroundInput = false) {
  const desktop = new FixtureDesktop()
  const service = new ComputerService(desktop, options)
  t.after(() => service.close())
  const signal = new AbortController().signal
  await service.windows(owner, signal)
  await service.share(owner, desktop.window.id, signal, foregroundInput)
  const observe = () => service.observe(owner, desktop.target.id, false, signal)
  const observation = await observe()
  const input = () => ({ targetId: desktop.target.id, observationId: desktop.observation.id,
    action: { kind: 'set_value' as const, elementId: '0', value: 'synthetic replacement' } })
  return { desktop, service, signal, observe, observation, input }
}
