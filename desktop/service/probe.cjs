'use strict'

// Plain Node entrypoint: runs under the packaged Electron binary in Node mode.
// This file contains no Electron imports and prints no credential or response body.
const { readFile } = require('node:fs/promises')

async function probe(path, { read = (path) => readFile(path, 'utf8'), request = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 30 } = {}) {
  const descriptor = JSON.parse(await read(path))
  if (descriptor.version !== 1 || descriptor.serviceName !== 'ShadowService' || descriptor.role !== 'main'
    || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535
    || descriptor.apiBase !== `http://127.0.0.1:${descriptor.port}`) {
    throw new Error('Invalid service connection')
  }
  const credential = (await read(descriptor.credentialPath)).trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(credential)) throw new Error('Invalid service credential')
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response
    try {
      response = await request(`${descriptor.apiBase}/local/v1/readiness`, {
        headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      })
    } catch {
      if (attempt + 1 < attempts) await delay(500)
      continue
    }
    if (response.status !== 200 && response.status !== 503) throw new Error('Service readiness rejected')
    if (response.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json') throw new Error('Service readiness contract mismatch')
    const body = await response.json()
    if (!body || Object.keys(body).length !== 3 || body.version !== 1 || body.role !== 'main'
      || !['ready', 'starting', 'stopping'].includes(body.status)
      || ((response.status === 200) !== (body.status === 'ready'))) throw new Error('Service readiness contract mismatch')
    if (response.status === 200) return
    if (attempt + 1 < attempts) await delay(500)
  }
  throw new Error('Service readiness timed out')
}

module.exports = { probe }
if (require.main === module) {
  probe(process.argv[2]).catch(() => {
    console.error('Authenticated service readiness failed. Check service state and protected logs.')
    process.exitCode = 1
  })
}
