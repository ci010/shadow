import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join, parse } from 'node:path'
import { platform } from 'node:os'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Aria2Downloader, downloadSchema, releaseBinary, requestedBinary, runAria2 } from './aria2.ts'

const bytes = Buffer.from('synthetic resumable release payload')
const sha256 = createHash('sha256').update(bytes).digest('hex')

test('pinned aria2 stages, resumes, hashes and atomically exposes approved files', async () => {
  await withTempWorkspace(async directory => {
    const calls: { args: string[]; input: string | undefined }[] = []
    let failOnce = true
    const downloader = new Aria2Downloader(async (_binary, args, _signal, input) => {
      calls.push({ args, input })
      const stage = join(directory, 'model.gguf.shadow-part')
      if (failOnce) {
        failOnce = false
        await writeFile(stage, bytes.subarray(0, 12))
        throw new Error('Network interrupted')
      }
      assert.deepEqual(await readFile(stage), bytes.subarray(0, 12))
      await writeFile(stage, bytes)
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n', async () => undefined)
    const input = {
      url: 'https://example.org/model.gguf?signature=private', directory, filename: 'model.gguf',
      sha256, bytes: bytes.length, approved: true as const,
    }
    await assert.rejects(() => downloader.download(input), /Network interrupted/)
    await assert.rejects(access(join(directory, 'model.gguf')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(directory, 'model.gguf.shadow-part')), bytes.subarray(0, 12))
    const result = await downloader.download(input)
    assert.deepEqual(result, { path: join(directory, 'model.gguf'), bytes: bytes.length, sha256, reused: false })
    assert.equal((await downloader.download(input)).reused, true)
    assert.equal(calls.length, 2)
    assert.ok(calls[0].args.includes('--continue=true') && calls[0].args.includes('--auto-file-renaming=false'))
    assert.ok(calls[0].args.includes('--input-file=-'))
    assert.ok(!calls[0].args.join(' ').includes('signature=private'))
    assert.equal(calls[0].input, `${input.url}\n  out=model.gguf.shadow-part\n`)
    await writeFile(result.path, 'different model')
    await assert.rejects(() => downloader.download(input), /refusing to overwrite/)
  })
})

test('download refuses unapproved, insecure, unverified or unsafe targets and discards corrupt payloads', async () => {
  await withTempWorkspace(async directory => {
    const downloader = new Aria2Downloader(async (_binary, args, _signal, commandInput) => {
      assert.ok(args.includes('--input-file=-'))
      assert.equal(commandInput, 'https://example.org/model.gguf\n  out=model.gguf.shadow-part\n')
      await writeFile(join(directory, 'model.gguf.shadow-part'), 'corrupt model')
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n', async () => undefined)
    const input = { url: 'https://example.org/model.gguf', directory, filename: 'model.gguf', sha256, approved: true as const }
    assert.throws(() => downloadSchema.parse({ ...input, approved: false }), /Invalid literal/)
    await assert.rejects(() => downloader.download({ ...input, url: 'http://example.org/model.gguf' }), /HTTPS/)
    await assert.rejects(() => downloader.download({ ...input, url: 'https://localhost/model.gguf' }), /HTTPS/)
    for (const host of ['localhost.', '127.1', '127.0.0.2', '[::1]']) {
      await assert.rejects(() => downloader.download({ ...input, url: `https://${host}/model.gguf` }), /HTTPS/)
    }
    await assert.rejects(() => downloader.download({ ...input, url: 'https://example.org/model.gguf\n  out=elsewhere' }), /whitespace/)
    await assert.rejects(() => downloader.download({ ...input, directory: parse(directory).root }), /bounded/)
    await assert.rejects(() => downloader.download({ ...input, filename: '..\\model.gguf' }), /safe single/)
    await assert.rejects(() => downloader.download({ ...input, filename: 'another.gguf.shadow-part' }), /safe single/)
    await assert.rejects(() => downloader.download({ ...input, filename: 'another.gguf.shadow-part.aria2' }), /safe single/)
    await assert.rejects(() => downloader.download({ ...input, sha256: 'unverified' }), /Invalid/)
    await assert.rejects(() => downloader.download(input), /failed its expected length or SHA-256/)
    await assert.rejects(access(join(directory, 'model.gguf.shadow-part')), { code: 'ENOENT' })
    await assert.rejects(access(join(directory, 'model.gguf')), { code: 'ENOENT' })
  })
})

test('concurrent downloads to the same target fail rather than mixing partial data', async () => {
  await withTempWorkspace(async directory => {
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const downloader = new Aria2Downloader(async () => {
      started()
      await held
      await writeFile(join(directory, 'model.gguf.shadow-part'), bytes)
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n', async () => undefined)
    const input = { url: 'https://example.org/model.gguf', directory, filename: 'model.gguf', sha256, approved: true as const }
    const running = downloader.download(input)
    await ready
    await assert.rejects(() => downloader.download(input), /already running/)
    const anotherProject = new Aria2Downloader(async () => {
      throw new Error('Concurrent project must not start a second transfer')
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n', async () => undefined)
    await assert.rejects(() => anotherProject.download(input), /already running/)
    release()
    await running
  })
})

test('signed URLs travel through stdin, not process arguments', async () => {
  const script = "const fs=require('node:fs'); if(!process.argv.includes('--input-file=-') || fs.readFileSync(0,'utf8') !== 'https://example.org/model?token=secret\\n  out=model.shadow-part\\n') process.exit(1)"
  await runAria2(process.execPath, ['-e', script, '--', '--input-file=-'], undefined,
    'https://example.org/model?token=secret\n  out=model.shadow-part\n')
})

test('configured proxies use the private stdin channel without weakening TLS or changing the source', async () => withTempWorkspace(async directory => {
  const downloader = new Aria2Downloader(async (_binary, args, _signal, input) => {
    assert.ok(args.includes('--all-proxy='))
    assert.ok(!args.some(value => value.includes('proxy.example') || value.includes('check-certificate=false')))
    assert.equal(input, 'https://example.org/model.gguf\n  out=model.gguf.shadow-part\n  all-proxy=http://proxy.example:8080/\n')
    await writeFile(join(directory, 'model.gguf.shadow-part'), bytes)
  }, () => process.execPath, async () => 'aria2 version 1.37.0\n', async url => {
    assert.equal(url, 'https://example.org/model.gguf')
    return 'http://proxy.example:8080/'
  })
  await downloader.download({ url: 'https://example.org/model.gguf', directory, filename: 'model.gguf', sha256, approved: true })
}))

test('download errors expose actionable categories without echoing signed URLs or raw output', async () => {
  for (const [diagnostic, expected] of [
    ['errorCode=1 SSL/TLS handshake failure: https://example.org/file?token=private-token', /TLS handshake/],
    ['Failed to resolve example.org; private-token', /DNS resolution/],
    ['Connection timed out private-token', /timed out/],
    ['HTTP status=403 private-token', /HTTP error/],
    ['some unrecognized failure private-token', /Inspect the approved source/],
  ] as const) {
    const script = `console.error(${JSON.stringify(diagnostic)});process.exitCode=1`
    await assert.rejects(runAria2(process.execPath, ['-e', script]), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, /private-token|https:\/\/|example\.org/)
      return true
    })
  }
})

test('cancellation settles only after the downloader process has exited', async () => withTempWorkspace(async directory => {
  const pidFile = join(directory, 'pid.txt')
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));setInterval(()=>{},1000)`
  const controller = new AbortController()
  const running = runAria2(process.execPath, ['-e', script], controller.signal)
  const rejected = assert.rejects(running, { name: 'AbortError' })
  let pid = 0
  try {
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      if (!pid) await delay(20)
    }
    assert.ok(pid)
  } finally { controller.abort() }
  await rejected
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
}))

test('packaged backend locates the neighboring fixed downloader instead of PATH', async () => {
  await withTempWorkspace(async root => {
    const module = join(root, 'resources', 'backend', 'dist', 'src', 'downloader', 'aria2.js')
    const filename = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
    assert.equal(releaseBinary(pathToFileURL(module).href), join(root, 'resources', 'aria2', filename))
    assert.equal(requestedBinary(pathToFileURL(module).href, ''), join(root, 'resources', 'aria2', filename))
  })
})

test('source and built development backends resolve the checkout binary independently of cwd', async () => {
  await withTempWorkspace(async root => {
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts', 'desktop.ts'), '// synthetic checkout marker')
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const filename = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
    for (const module of [join(root, 'src', 'downloader', 'aria2.ts'), join(root, 'dist', 'src', 'downloader', 'aria2.js')]) {
      assert.equal(requestedBinary(pathToFileURL(module).href, ''), join(root, 'desktop', 'aria2', filename))
      assert.equal(requestedBinary(pathToFileURL(module).href, process.execPath), process.execPath)
      assert.throws(() => requestedBinary(pathToFileURL(module).href, filename), /must be absolute/)
    }
    const downloader = new Aria2Downloader(undefined, () => requestedBinary(pathToFileURL(join(root, 'src', 'downloader', 'aria2.ts')).href, ''))
    await assert.rejects(downloader.status(), /Pinned aria2c 1\.37\.0 is missing:.*SHADOW_ARIA2C_PATH/)
  })
})

test('downloads fail closed on a different aria2 version', async () => {
  await withTempWorkspace(async directory => {
    const downloader = new Aria2Downloader(async () => {
      throw new Error('Must never run the wrong binary')
    }, () => process.execPath, async () => 'aria2 version 1.36.0\n')
    await assert.rejects(() => downloader.download({
      url: 'https://example.org/model.gguf', directory, filename: 'model.gguf', sha256, approved: true,
    }), /must be version 1\.37\.0/)
  })
})

test('existing symlink destination is not treated as a verified file', async t => {
  await withTempWorkspace(async directory => {
    await writeFile(join(directory, 'existing.gguf'), bytes)
    try {
      await symlink(join(directory, 'existing.gguf'), join(directory, 'model.gguf'))
    } catch (error) {
      if (platform() === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        t.skip('Windows symlinks require Developer Mode or elevated permissions')
        return
      }
      throw error
    }
    const downloader = new Aria2Downloader(async () => {
      throw new Error('Must not download into a symlink destination')
    }, () => process.execPath, async () => 'aria2 version 1.37.0\n')
    await assert.rejects(() => downloader.download({
      url: 'https://example.org/model.gguf', directory, filename: 'model.gguf', sha256, approved: true,
    }), /refusing to overwrite/)
  })
})
