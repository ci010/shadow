import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from './service.ts'
import { WorkflowRuntime } from '../workflows/runtime.ts'
import { getProjectScope, type ProjectScope } from '../projects/scope.ts'

/** Explicit disposable test composition; production always injects its Project runtime. */
export class TestCronService extends CronService {
  readonly workflow: WorkflowRuntime
  private temporary?: string
  constructor(directory: string, timezone = 'UTC', scope: ProjectScope | undefined = getProjectScope(), projectId = scope?.projectId ?? 'fixture') {
    const temporary = directory === '.' ? mkdtempSync(join(tmpdir(), 'shadow-cron-workflow-')) : undefined
    const workflow = new WorkflowRuntime(temporary ?? directory, projectId, {
      canUse: () => true, deliver: async () => { throw new Error('Schedule tests must use the bound action adapter') },
    })
    workflow.start()
    super(directory, workflow, timezone, scope)
    this.workflow = workflow
    this.temporary = temporary
  }
  override async start() { this.workflow.start(); await super.start() }
  override async stop() {
    try { await super.stop() } finally { await this.workflow.stop(); if (this.temporary) rmSync(this.temporary, { recursive: true, force: true }) }
  }
}
