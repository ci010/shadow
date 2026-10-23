import { join } from 'node:path'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { CapabilityShell } from '../execution/capability-shell.ts'
import { DURABLE_SHELL_OPERATION, JournaledShellExecutor, ShellJournal } from '../execution/shell-journal.ts'

const [root, jobId, lifetime] = process.argv.slice(2)
const journal = new ShellJournal(join(root, 'journal'))
class ReportingProcessManager extends ProcessManager {
  override async spawn(...args: Parameters<ProcessManager['spawn']>) {
    const managed = await super.spawn(...args)
    process.send?.({ type: 'guardian', pid: managed.process.pid, commandPid: managed.pid })
    return managed
  }
}
const manager = new ReportingProcessManager()
const executor = new JournaledShellExecutor(new LocalExecutor(manager, 'child', [
  new CapabilityShell([{ capabilityId: 'root', rootPath: root }]),
], [], request => journal.processResultPath(request)), journal)
const deadline = Date.now() + Number(lifetime)
const request = {
  version: 1 as const, jobId, idempotencyKey: jobId, nodeId: 'child', sessionId: 'session', turnId: 'turn',
  capabilityId: 'root', operation: DURABLE_SHELL_OPERATION,
  args: { script: `"${process.execPath}" "command with spaces.cjs"` },
  createdAt: new Date().toISOString(), deadlineAt: new Date(deadline).toISOString(),
}
for await (const event of executor.execute(request, new AbortController().signal)) {
  process.send?.(event)
}
if (process.connected) process.disconnect()
