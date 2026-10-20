import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerDesktop } from './factory.ts'
import { AgentDesktopComputerDesktop } from './agent-desktop.ts'
import { WindowsComputerDesktop } from './windows.ts'

test('backend selection is explicit and defaults to unchanged existing host without starting it', () => {
  assert.ok(createComputerDesktop({}) instanceof WindowsComputerDesktop)
  assert.ok(createComputerDesktop({ SHADOW_COMPUTER_BACKEND: '' }) instanceof WindowsComputerDesktop)
  assert.ok(createComputerDesktop({ SHADOW_COMPUTER_BACKEND: 'powershell' }) instanceof WindowsComputerDesktop)
  assert.ok(createComputerDesktop({ SHADOW_COMPUTER_BACKEND: 'agent-desktop' }) instanceof AgentDesktopComputerDesktop)
})

test('unknown backends fail closed rather than quietly falling back', () => {
  for (const value of ['Agent-Desktop', 'native', ' agent-desktop ', 'false']) {
    assert.throws(() => createComputerDesktop({ SHADOW_COMPUTER_BACKEND: value }), /Invalid SHADOW_COMPUTER_BACKEND/)
  }
})
