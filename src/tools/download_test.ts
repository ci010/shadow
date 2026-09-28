import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Aria2Downloader } from '../downloader/aria2.ts'
import type { Executor } from '../execution/executor.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from './registry.ts'
import { DownloadTool } from './download.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { ExecutionContext } from './context.ts'

test('download tool requires owning local Project and human-approved hash-bound request', async () => {
  await withTempWorkspace(async root => {
    const cwd = join(root, 'session')
    await mkdir(cwd)
    const downloader = new Aria2Downloader(async () => {
      await writeFile(join(root, 'file.bin.shadow-part'), 'bytes')
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n')
    const tool = new DownloadTool(downloader, 'owner')
    const context: ExecutionContext = {
      channel: 'system', messageId: 'test', senderId: 'test', chatId: 'test',
      sessionId: 'session', physicalSessionId: 'session', cwd, projectId: 'owner',
      signal: new AbortController().signal, tools: new SessionTools(new Tools(root), root),
    }
    const request = {
      action: 'download', directory: root, filename: 'file.bin', url: 'https://example.org/file.bin',
      sha256: '0'.repeat(64), approved: true,
    }
    await assert.rejects(() => tool.execute(request, { ...context, projectId: 'other' }), /owning Project/)
    await assert.rejects(() => tool.execute(request, { ...context, remoteWorkdir: {
      nodeId: 'remote', capabilityId: 'remote', executor: {} as Executor,
    } }), /local workdir/)
    await assert.rejects(() => tool.execute({ ...request, approved: false }, context))
    await assert.rejects(() => tool.execute({ action: 'status', extra: true }, context))
    await assert.rejects(() => tool.execute(request, context), /failed its expected length or SHA-256/)
  })
})

test('large downloads return a background execution ID and expose verified completion', async () => {
  await withTempWorkspace(async root => {
      const cwd = join(root, 'session')
      await mkdir(cwd)
      const payload = Buffer.from('download finished')
      let release!: () => void
      let signalReady!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const ready = new Promise<void>(resolve => { signalReady = resolve })
      const downloader = new Aria2Downloader(async () => {
        await writeFile(join(root, 'weight.gguf.shadow-part'), payload)
        signalReady()
        await held
      }, () => process.execPath, async () => 'aria2 version 1.37.0\n')
      let completion!: Promise<string>
      let observe!: () => string | Promise<string>
      const tasks: Pick<BackgroundTaskManager, 'runPromiseTask'> = {
        runPromiseTask(options, promise) {
          completion = promise
          observe = options.observe!
          return '0000000000000001'
        },
      }
      const tool = new DownloadTool(downloader, 'owner', tasks)
      const context: ExecutionContext = {
        channel: 'system', messageId: 'test', senderId: 'test', chatId: 'test',
        sessionId: 'session', physicalSessionId: 'session', cwd, projectId: 'owner',
        signal: new AbortController().signal, tools: new SessionTools(new Tools(root), root),
      }
      const result = JSON.parse(await tool.execute({
        action: 'start', url: 'https://example.org/weight.gguf', directory: root,
        filename: 'weight.gguf', sha256: createHash('sha256').update(payload).digest('hex'),
        approved: true,
      }, context))
      assert.equal(result.executionId, 'bg:0000000000000001')
      assert.equal(result.outputPath, 'v:bg/bg:0000000000000001')
      assert.equal(result.taskId, '0000000000000001')
      await ready
      assert.equal(JSON.parse(await observe()).downloadedBytes, payload.length)
      release()
      const completed = JSON.parse(await completion)
      assert.equal(completed.path, join(root, 'weight.gguf'))
      assert.deepEqual(await readFile(completed.path), payload)
  })
})
