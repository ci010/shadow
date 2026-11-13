import { SignalProviderRuntime } from './runtime.ts'
import { WorkflowRuntime } from '../../workflows/runtime.ts'
import type { DeliverInput } from '../../sessions/input.ts'

/** Disposable test host composition, not a second production executor. */
export class TestSignalProviderRuntime extends SignalProviderRuntime {
  readonly workflow: WorkflowRuntime
  constructor(directory: string, broker: ConstructorParameters<typeof SignalProviderRuntime>[1], deliver: DeliverInput,
    canUse: (id: string) => boolean, hasCredential: (ref: string) => boolean) {
    const workflow = new WorkflowRuntime(directory, 'fixture', { canUse, deliver })
    super(directory, broker, workflow, canUse, hasCredential)
    this.workflow = workflow
  }
  override start() { this.workflow.start(); super.start() }
  override async stop() { await this.workflow.stop(); await super.stop() }
}
