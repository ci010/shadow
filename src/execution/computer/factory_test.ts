import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentDesktopComputerDesktop } from './agent-desktop.ts'
import { createComputerDesktop } from './factory.ts'

test('default desktop is always native, regardless of obsolete environment values', () => {
  const previous = process.env.SHADOW_COMPUTER_BACKEND
  try {
    for (const value of [undefined, '', 'powershell', 'agent-desktop', 'invalid']) {
      if (value === undefined) delete process.env.SHADOW_COMPUTER_BACKEND
      else process.env.SHADOW_COMPUTER_BACKEND = value
      assert.ok(createComputerDesktop() instanceof AgentDesktopComputerDesktop)
    }
  } finally {
    if (previous === undefined) delete process.env.SHADOW_COMPUTER_BACKEND
    else process.env.SHADOW_COMPUTER_BACKEND = previous
  }
})
