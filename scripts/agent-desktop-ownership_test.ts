import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

// A platform feasibility probe, NOT a desktop action or a proposed cleanup
// implementation. Reproduces the process_group(0) boundary used by the official
// macOS clipboard helper. Both fixtures are inert Node processes; the helper
// exits on its own and no process-name/PID-tree discovery or OS grants are used.
test('a separately grouped helper survives termination of its launcher group', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async () => {
  const helper = `setTimeout(() => { console.log('helper-completed'); }, 500)`
  const launcher = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {
      detached: true, stdio: ['ignore', 1, 'ignore'],
    });
    child.once('spawn', () => console.log('launcher-ready'));
    child.once('error', () => process.exit(2));
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', launcher], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const closed = once(child, 'close')
  let output = ''
  let terminated = false
  child.stdout.on('data', chunk => {
    output += chunk.toString()
    if (!terminated && output.includes('launcher-ready')) {
      terminated = true
      // This is the live, directly spawned launcher handle's group, never an
      // untrusted PID from a file, process-name match, or another session.
      process.kill(-child.pid!, 'SIGTERM')
    }
  })
  try {
    const [code, signal] = await exited
    assert.equal(code, null)
    assert.equal(signal, 'SIGTERM')
    await closed // Includes helper's inherited pipe EOF, not only launcher exit.
    assert.equal(terminated, true)
    assert.match(output, /helper-completed/)
  } finally {
    // Never signal the numeric group after launcher exit (PID reuse).
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
