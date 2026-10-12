import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { handleOpenCopilotLogin } from './ipc-contract.js'

test('Copilot IPC opens the exact supplied GitHub.com or enterprise device page', async () => {
  const opened: string[] = []
  for (const host of ['github.com', 'octocat.ghe.com', 'a.ghe.com', 'my-company.ghe.com', `${'a'.repeat(63)}.ghe.com`]) {
    const uri = `https://${host}/login/device`
    await handleOpenCopilotLogin(async (url) => { opened.push(url) }, [uri])
    assert.equal(opened.at(-1), uri)
  }
})

test('Copilot IPC rejects non-canonical, untrusted or malformed device links before opening', async () => {
  const opened: string[] = []
  const invalid = [
    'https://evil.example', 'http://github.com/login/device',
    'https://ghe.com/login/device', 'https://nested.tenant.ghe.com/login/device',
    'https://tenant.ghe.com.evil.example/login/device', 'https://tenant.github.com/login/device',
    'https://-tenant.ghe.com/login/device', 'https://tenant-.ghe.com/login/device',
    'https://tenant_name.ghe.com/login/device', 'https://xn--tenant.ghe.com/login/device',
    `https://${'a'.repeat(64)}.ghe.com/login/device`,
    'https://github.com@evil.example/login/device', 'https://user@github.com/login/device',
    'https://user:password@tenant.ghe.com/login/device',
    'https://github.com:443/login/device', 'https://tenant.ghe.com:8443/login/device',
    'https://github.com/login/device?code=secret', 'https://tenant.ghe.com/login/device#code',
    'https://github.com/login/device?', 'https://tenant.ghe.com/login/device#',
    'https://github.com/login/device/', 'https://github.com/login/./device',
    'https://github.com/other/../login/device', 'https://tenant.ghe.com/login/%64evice',
    'https://github.com./login/device', 'https://%67ithub.com/login/device',
    'https://GITHUB.COM/login/device', 'https://ténant.ghe.com/login/device',
    'https://github.com\\login\\device', 'https://tenant.ghe.com/settings/tokens',
    ' https://github.com/login/device', 'https://github.com/login/device\n',
    'https://github.com/login/device\r', 'https://github.com/login/device\u2028',
  ]
  for (const args of [[], [undefined], [null], [42], [{}], ['https://github.com/login/device', 'extra'], ...invalid.map(uri => [uri])]) {
    await assert.rejects(handleOpenCopilotLogin(async (url) => { opened.push(url) }, args), /trusted HTTPS device verification URI/)
  }
  assert.deepEqual(opened, [])
})

test('preload forwards the verification URI and Main routes through the strict handler', () => {
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(preload, /copilotLoginHostSupport: true/)
  assert.match(preload, /openCopilotLogin:\s*\(verificationUri: string\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.openCopilotLogin, verificationUri\)/)
  assert.match(main, /IPC_CHANNELS\.openCopilotLogin,[\s\S]*?handleOpenCopilotLogin\(\(url\) => shell\.openExternal\(url\), rawArguments\)/)
})
