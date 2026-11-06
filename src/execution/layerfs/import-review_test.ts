import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { classifyLayerFSName, LayerFSImportReview } from './import-review.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'

const owner = JSON.stringify(['synthetic-project', 'synthetic-session'])
const signal = () => new AbortController().signal
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.layerfs-import-review-test-'))
  try { await work(root) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('safe baseline: JSON-safe metadata summary, hidden source dirs and template env files allowed', async () => {
  await fixture(async root => {
    await mkdir(join(root, '.github'))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, '.github', 'workflow.yml'), 'abc')
    await writeFile(join(root, 'src', 'main.ts'), '12345')
    await writeFile(join(root, '.env.example'), 'EXAMPLE=')
    await writeFile(join(root, '.env.sample'), '')
    const review = new LayerFSImportReview()
    const result = await review.preview(root, owner, signal())
    assert.equal(result.status, 'review_required')
    assert.match(result.reviewToken!, /^[a-f0-9]{64}$/)
    assert.deepEqual(result.summary, { entries: 6, files: 4, directories: 2, bytes: 16, complete: true })
    assert.deepEqual(result.blockers, [])
    assert.equal(result.blockersTruncated, false)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    assert.match(result.warning, /no file contents were read/)
    assert.match(result.warning, /not a credential-free certification/)
    assert.match(result.warning, /mutable tree, not a snapshot/)
    assert.match(result.next, /separate curated, registered baseline/)
    assert.match(result.next, /Never delete or move blocked files from the original checkout/)
    assert.match(result.next, /import_preview/)
    assert.match(result.next, /sourceReview: <reviewToken> and sourceReviewed: true/)
    // Equivalent lexical paths are accepted; the root's metadata isn't a content read.
    await review.consume(result.reviewToken, relative(process.cwd(), root), owner, true, signal())
    await assert.rejects(review.consume(result.reviewToken, root, owner, true, signal()), ToolNoEffectError)
  })
})

test('obvious dependency, environment, bot config and credential names block without traversing excluded dirs', async () => {
  await fixture(async root => {
    for (const name of ['.git', '.venv', 'venv', 'node_modules', '.ssh', '.aws']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'never-enumerated.txt'), 'synthetic')
    }
    const files = ['.env', '.env.local', '.env.production', '.env.example.local', '.envrc', 'bot.config.json', 'id_rsa', 'private-key.txt', 'credentials.json', 'secrets.yaml', 'test.pem', 'test.key', 'test.p12', 'test.ppk', 'service-account.json', '.npmrc', '.credentials.json', '.secrets', 'production.credentials.json', '.dockercfg']
    for (const name of files) await writeFile(join(root, name), 'synthetic')
    const review = new LayerFSImportReview()
    const result = await review.preview(root, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.equal(result.reviewToken, undefined)
    assert.equal(result.summary.entries, files.length + 6)
    assert.equal(result.summary.complete, false)
    assert.equal(result.blockers.length, files.length + 6)
    assert.ok(result.blockers.every(b => !b.path.includes('never-enumerated')))
    await assert.rejects(review.consume(undefined, root, owner, true, signal()), ToolNoEffectError)
  })
})

test('empty, missing, non-directory sources and excluded source roots fail closed without raw errors', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'file.txt'), 'synthetic')
    await mkdir(join(root, '.git'))
    const review = new LayerFSImportReview()
    for (const source of ['', join(root, 'missing'), join(root, 'file.txt'), join(root, '.git')]) {
      const result = await review.preview(source, owner, signal())
      assert.equal(result.status, 'blocked')
      assert.equal(result.reviewToken, undefined)
      assert.equal(result.summary.complete, false)
      assert.ok(!JSON.stringify(result).includes(root))
    }
    assert.equal((await review.preview(root, '', signal())).status, 'blocked')
  })
})

test('tokens require exact project/session, resolved source, literal review; invalid attempts do not import', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'other'))
    const review = new LayerFSImportReview()
    const token = (await review.preview(root, owner, signal())).reviewToken
    for (const reviewed of [false, undefined, 'true', 1, {}]) {
      await assert.rejects(review.consume(token, root, owner, reviewed, signal()), error => {
        assert.ok(error instanceof ToolNoEffectError)
        assert.match(error.message, /sourceReviewed: true/)
        return true
      })
    }
    for (const tokenValue of [undefined, {}, 123, 'invented']) {
      await assert.rejects(review.consume(tokenValue, root, owner, true, signal()), ToolNoEffectError)
    }
    await assert.rejects(review.consume(token, root, 'other-project/session', true, signal()), ToolNoEffectError)
    await assert.rejects(review.consume(token, join(root, 'other'), owner, true, signal()), ToolNoEffectError)
    await assert.rejects(new LayerFSImportReview().consume(token, root, owner, true, signal()), ToolNoEffectError)
    await review.consume(token, root, owner, true, signal())
  })
})

test('single-use reservation rejects concurrent consumers', async () => {
  await fixture(async root => {
    const review = new LayerFSImportReview()
    const token = (await review.preview(root, owner, signal())).reviewToken
    const results = await Promise.allSettled([
      review.consume(token, root, owner, true, signal()),
      review.consume(token, root, owner, true, signal()),
    ])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    assert.ok(rejected.reason instanceof ToolNoEffectError)
  })
})

test('tokens expire at 15 minutes, not just after', async t => {
  await fixture(async root => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const review = new LayerFSImportReview()
    const token = (await review.preview(root, owner, signal())).reviewToken
    t.mock.timers.tick(15 * 60_000)
    await assert.rejects(review.consume(token, root, owner, true, signal()), ToolNoEffectError)
    const fresh = (await review.preview(root, owner, signal())).reviewToken
    t.mock.timers.tick(15 * 60_000 - 1)
    await review.consume(fresh, root, owner, true, signal())
  })
})

test('metadata changes (write/add/remove/rename/new blocker) reject and invalidate token', async t => {
  const changes = {
    write: (root: string) => writeFile(join(root, 'file.txt'), 'changed size'),
    add: (root: string) => writeFile(join(root, 'added.txt'), 'x'),
    remove: (root: string) => rm(join(root, 'file.txt')),
    rename: (root: string) => rename(join(root, 'file.txt'), join(root, 'renamed.txt')),
    blocker: (root: string) => writeFile(join(root, '.env'), 'SYNTHETIC='),
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    await fixture(async root => {
      await writeFile(join(root, 'file.txt'), 'original')
      const review = new LayerFSImportReview()
      const token = (await review.preview(root, owner, signal())).reviewToken
      await change(root)
      await assert.rejects(review.consume(token, root, owner, true, signal()), ToolNoEffectError)
      await assert.rejects(review.consume(token, root, owner, true, signal()), ToolNoEffectError)
    })
  })
})

test('directory symlinks/junctions, linked roots and linked ancestors fail closed', async () => {
  await fixture(async root => {
    const target = join(root, 'target'), source = join(root, 'source'), link = join(source, 'link')
    await mkdir(join(target, 'nested'), { recursive: true })
    await mkdir(source)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const review = new LayerFSImportReview()
    const result = await review.preview(source, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.blockers, [{ path: 'link', reason: 'symbolic_link' }])
    assert.equal((await review.preview(link, owner, signal())).status, 'blocked')
    assert.equal((await review.preview(join(link, 'nested'), owner, signal())).status, 'blocked')
  })
})

test('bounded traversal and findings fail closed with relative, encoded names', async () => {
  await fixture(async root => {
    for (let i = 0; i < 6; i++) await writeFile(join(root, `credentials.${i}.json`), 'x')
    await writeFile(join(root, 'credentials.名字.json'), 'x')
    const findings = await new LayerFSImportReview({ maxFindings: 2 }).preview(root, owner, signal())
    assert.equal(findings.status, 'blocked')
    assert.equal(findings.blockers.length, 2)
    assert.equal(findings.blockersTruncated, true)
    assert.ok(findings.blockers.every(b => b.path.length <= 240 && !b.path.includes(root)))
    const all = await new LayerFSImportReview().preview(root, owner, signal())
    assert.ok(all.blockers.some(b => b.path.includes('%E5%90%8D')))
    const entries = await new LayerFSImportReview({ maxEntries: 2 }).preview(root, owner, signal())
    assert.equal(entries.status, 'blocked')
    assert.equal(entries.summary.entries, 2)
    assert.equal(entries.summary.complete, false)
    assert.ok(entries.blockers.some(b => b.reason === 'scan_entry_limit'))
  })
})

test('aborted scans and consumption fail closed', async () => {
  await fixture(async root => {
    const review = new LayerFSImportReview(), aborted = new AbortController()
    aborted.abort()
    const result = await review.preview(root, owner, aborted.signal)
    assert.equal(result.status, 'blocked')
    assert.equal(result.blockers[0]?.reason, 'scan_aborted')
    const token = (await review.preview(root, owner, signal())).reviewToken
    await assert.rejects(review.consume(token, root, owner, true, aborted.signal), ToolNoEffectError)
    const during = new AbortController()
    const pending = review.preview(root, owner, during.signal)
    during.abort()
    assert.equal((await pending).status, 'blocked')
  })
})

test('scan deadline is enforced independently of wall-clock token TTL', async t => {
  await fixture(async root => {
    let elapsed = 0
    t.mock.method(performance, 'now', () => elapsed += 10)
    const result = await new LayerFSImportReview({ maxDurationMs: 1 }).preview(root, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.equal(result.blockers[0]?.reason, 'scan_time_limit')
  })
})

test('unreadable directory fails closed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  await fixture(async root => {
    const denied = join(root, 'denied')
    await mkdir(denied)
    await chmod(denied, 0)
    try {
      const result = await new LayerFSImportReview().preview(root, owner, signal())
      assert.equal(result.status, 'blocked')
      assert.ok(result.blockers.some(b => b.reason === 'unreadable_or_unstable_entry'))
    } finally { await chmod(denied, 0o700) }
  })
})

test('special files fail closed without opening their contents', { skip: process.platform === 'win32' }, async () => {
  await fixture(async root => {
    const made = spawnSync('mkfifo', [join(root, 'pipe')], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const result = await new LayerFSImportReview().preview(root, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.blockers, [{ path: 'pipe', reason: 'special_file' }])
  })
})


test('credential-related code, tests, docs and assets warn without bypassing explicit content review', async () => {
  await fixture(async root => {
    const names = ['credentials.svg', 'secret-redaction.ts', 'secrets_test.ts', 'credentials.md', 'service-account.test.ts', 'private-key-icon.png', 'secret-guide.txt']
    for (const name of names) await writeFile(join(root, name), 'synthetic')
    const review = new LayerFSImportReview({ maxFindings: 3 })
    const result = await review.preview(root, owner, signal())
    assert.equal(result.status, 'review_required')
    assert.deepEqual(result.blockers, [])
    assert.equal(result.warnings.length, 3)
    assert.equal(result.warningsTruncated, true)
    await assert.rejects(review.consume(result.reviewToken, root, owner, false, signal()), ToolNoEffectError)
    await review.consume(result.reviewToken, root, owner, true, signal())
  })
})

test('code-looking files do not exempt credential directories', async () => {
  await fixture(async root => {
    for (const name of ['credentials', '.secrets', '.ssh', 'service-account', '.aws']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'innocent.ts'), 'synthetic')
    }
    const result = await new LayerFSImportReview().preview(root, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.equal(result.blockers.length, 5)
    assert.deepEqual(result.warnings, [])
    assert.equal(result.warningsTruncated, false)
  })
})


test('exact credential plaintext/export names block without reclassifying explanatory names or assets', async () => {
  const blocked: string[] = []
  for (const name of ['credential', 'credentials', 'secret', 'secrets']) {
    for (const extension of ['txt', 'csv', 'tsv', 'bak', 'log']) {
      for (const prefix of ['', '.']) {
        const path = `${prefix}${name}.${extension}`
        blocked.push(path)
        assert.deepEqual(classifyLayerFSName(path), { blocker: 'possible_credentials_or_private_key' }, path)
        assert.deepEqual(classifyLayerFSName(path.toUpperCase()), { blocker: 'possible_credentials_or_private_key' }, path)
      }
    }
  }
  for (const path of ['credentials.svg', 'secret-redaction.ts', 'secret-guide.txt', 'credentials-explanation.csv', 'secrets-format.tsv', 'credential-example.bak', 'secret-redaction.log']) {
    assert.deepEqual(classifyLayerFSName(path), { warning: 'credential_related_name_requires_content_review' }, path)
  }
  await fixture(async root => {
    for (const path of blocked) await writeFile(join(root, path), 'synthetic')
    const result = await new LayerFSImportReview().preview(root, owner, signal())
    assert.equal(result.status, 'blocked')
    assert.equal(result.reviewToken, undefined)
    assert.equal(result.blockers.length, blocked.length)
    assert.deepEqual(result.warnings, [])
  })
})
