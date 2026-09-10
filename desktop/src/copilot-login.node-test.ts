import assert from 'node:assert/strict'
import test from 'node:test'
import { handleOpenCopilotLogin } from './ipc-contract.js'

test('Copilot IPC opens only the trusted HTTPS device page', async () => {
  const opened: string[] = []
  await handleOpenCopilotLogin(async (url) => { opened.push(url) }, [])
  assert.deepEqual(opened, ['https://github.com/login/device'])
  await assert.rejects(
    handleOpenCopilotLogin(async (url) => { opened.push(url) }, ['https://evil.example']),
    /no arguments/,
  )
  assert.equal(opened.length, 1)
})
