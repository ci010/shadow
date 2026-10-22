import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts') ? [path] : []
  }))).flat()
}

async function moduleReferences(file: string): Promise<string[]> {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const references: string[] = []
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)) {
      references.push(node.argument.literal.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      references.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return references.map(reference => reference.startsWith('.')
    ? relative(sourceRoot, resolve(dirname(file), reference)).split(sep).join('/') : reference)
}

test('execution capabilities do not depend on HTTP gateway modules', async () => {
  for (const file of await productionFiles(resolve(sourceRoot, 'execution'))) {
    for (const reference of await moduleReferences(file)) {
      assert(!reference.startsWith('gateway/'), `${relative(sourceRoot, file)} depends on ${reference}`)
      assert(reference !== 'hono' && !reference.startsWith('hono/'),
        `${relative(sourceRoot, file)} depends on the HTTP framework`)
    }
  }
})

test('tool implementations depend on execution contracts, not the agent application router', async () => {
  for (const file of await productionFiles(resolve(sourceRoot, 'tools'))) {
    assert(!(await moduleReferences(file)).includes('agent/app.ts'), relative(sourceRoot, file))
  }
})

test('Main composition does not import the public process entrypoint or slash-command business logic', async () => {
  for (const file of await productionFiles(resolve(sourceRoot, 'runtime', 'main'))) {
    const references = await moduleReferences(file)
    assert(!references.includes('index.ts'), relative(sourceRoot, file))
  }
  const handler = await readFile(resolve(sourceRoot, 'slash-commands', 'handlers', 'learn.ts'), 'utf8')
  assert(!/\bfunction\s+(?:triggerReflectorFlush|computeSessionDiff|writeWatermark)\b/.test(handler),
    'Learning pipelines belong to agent/learning, not the slash-command adapter')
})
