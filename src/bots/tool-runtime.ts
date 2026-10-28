import { posix } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { z } from 'zod'
import { validateJsonSchema } from '../agent-authoring/capabilities.ts'
import { executeScript } from '../script-runtime/runtime.ts'
import { encodeJson, MAX_JSON_BYTES } from '../script-runtime/json-boundary.ts'
import { parseBot, type BotDefinition, BotSourcePathSchema } from './sdk.ts'

export interface ExecuteBotToolOptions {
  files: Record<string, string>
  tool: string
  args: Record<string, unknown>
  signal: AbortSignal
  /** Effective binding-specific names, not the bot-wide tool list. */
  allowedTools: readonly string[]
  /** Recheck current binding/identity/revision before execution AND every callback. */
  authorize(request: { bot: BotDefinition; tool: BotDefinition['tools'][number]; args: Record<string, unknown> }, signal: AbortSignal): void | Promise<void>
  callModule?(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  services?(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  channel?(operation: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  storage?(operation: 'get' | 'set' | 'delete', input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  log?(level: 'info' | 'warn' | 'error', message: string, signal: AbortSignal): void | Promise<void>
  timeoutMs?: number
  maxCalls?: number
}

const sdkSource = 'export const defineTool = (tool) => tool;'
const entrySource = (module: string, exported: string, description:string, parameters:Record<string,unknown>) => `
import * as toolModule from ${JSON.stringify('./' + module)};
import bridge from '@shadow/bot-runtime';
const rpc = async (kind, name, input = {}) => {
  try { return await bridge({ kind, name, input }); }
  catch { throw new Error('Bot capability failed'); }
};
const ctx = Object.freeze({
  services: Object.freeze({call: (name, input) => rpc('services', name, input)}),
  channel: Object.freeze({call: (name, input) => rpc('channel', name, input)}),
  storage: Object.freeze({get: key => rpc('storage', 'get', {key}), set: (key, value) => rpc('storage', 'set', {key, value}), delete: key => rpc('storage', 'delete', {key})}),
  log: Object.freeze(Object.fromEntries(['info','warn','error'].map(level => [level, message => rpc('log', level, {message}).then(() => undefined)]))),
  signal: Object.freeze({aborted: false, throwIfAborted() {}}),
});
export async function run(args) {
  const tool = toolModule[${JSON.stringify(exported)}];
  if (!tool || typeof tool.execute !== 'function') throw new Error('Tool export must be defineTool({execute})');
  const canonical = value => Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : value && typeof value === 'object' ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value);
  if (tool.description !== undefined && tool.description !== ${JSON.stringify(description)}) throw new Error('Tool description differs from approved declaration');
  if (tool.parameters !== undefined && canonical(tool.parameters) !== canonical(${JSON.stringify(parameters)})) throw new Error('Tool parameters differ from approved declaration');
  return await tool.execute(args, ctx);
}
`

/** Bundle virtual package sources only. No plugin resolves or loads host files. */
async function bundle(files: Record<string, string>, tool: BotDefinition['tools'][number]): Promise<string> {
  const result = await build({
    entryPoints: ['bot-entry'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2024', logLevel: 'silent',
    plugins: [{ name: 'bot-package-only', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return { path: 'entry', namespace: 'bot-entry' }
        if (args.path === '@shadow/bot-runtime' && args.namespace === 'bot-entry') return { path: args.path, external: true }
        if (args.path === '@shadow/bot-sdk') return { path: 'sdk', namespace: 'bot-sdk' }
        if (args.namespace === 'bot-capability' && args.path === args.importer) return { path: args.path, external: true }
        if (tool.imports.includes(args.path)) return { path: args.path, namespace: 'bot-capability' }
        if (!args.path.startsWith('./') && !args.path.startsWith('../')) throw new Error(`Bot import denied: ${args.path}`)
        const path = posix.normalize(posix.join(args.namespace === 'bot-files' ? posix.dirname(args.importer) : '', args.path))
        BotSourcePathSchema.parse(path)
        if (!Object.hasOwn(files, path) || !/\.(?:[cm]?js|[cm]?ts)$/.test(path)) throw new Error(`Bot source not found: ${path}`)
        return { path, namespace: 'bot-files' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'bot-entry' }, () => ({contents: entrySource(tool.module, tool.export ?? 'default',tool.description,tool.parameters), loader: 'js'}))
      builder.onLoad({ filter: /.*/, namespace: 'bot-capability' }, args => ({ contents: `
        import raw from ${JSON.stringify(args.path)};
        export const call = async (input = {}) => { try { return await raw(input); } catch { throw new Error('Bot capability failed'); } };
        export default call;
        export const fetch = async (path, options = {}) => call({...options, path, method: options.method ?? 'GET'});
      `, loader: 'js' }))
      builder.onLoad({ filter: /.*/, namespace: 'bot-sdk' }, () => ({ contents: sdkSource, loader: 'js' }))
      builder.onLoad({ filter: /.*/, namespace: 'bot-files' }, args => {
        const contents = files[args.path]!
        const ast = ts.createSourceFile(args.path, contents, ts.ScriptTarget.Latest, true)
        const check = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) throw new Error('Dynamic module loading denied')
          ts.forEachChild(node, check)
        }
        check(ast)
        return { contents, loader: /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js' }
      })
    } }],
  })
  // Nonliteral loading cannot bypass the child allowlist; reject esbuild's
  // unsupported-loading warnings too so dependencies remain reviewable.
  if (result.warnings.length) throw new Error('Bot tool contains unsupported non-static module loading')
  const code = result.outputFiles[0]!.text
  if (Buffer.byteLength(code) > MAX_JSON_BYTES) throw new Error('Bundled bot tool exceeds size limit')
  return code
}

const requestSchema = z.object({ kind: z.enum(['services', 'channel', 'storage', 'log']), name: z.string().min(1).max(128), input: z.record(z.unknown()) }).strict()
const keySchema = z.string().min(1).max(256)

/** Host callbacks implement capability-scoped operations, not raw clients,
 * credentials, arbitrary paths or URLs. A fresh restricted child owns each call.
 * No native modules allowed. The existing VM runtime is not an OS sandbox.
 */
export async function executeBotTool(options: ExecuteBotToolOptions): Promise<unknown> {
  const files = { ...options.files }
  const bot = parseBot(files)
  const tool = bot.tools.find(t => t.name === options.tool)
  if (!tool || !options.allowedTools?.includes(tool.name)) throw new Error('Bot tool is not allowed by this binding')
  const args = JSON.parse(encodeJson(options.args, 'bot arguments', true)) as Record<string, unknown>
  validateJsonSchema(tool.parameters, args)
  const timeoutMs = z.number().int().min(1).max(60_000).parse(options.timeoutMs ?? 15_000)
  const maxCalls = z.number().int().min(0).max(128).parse(options.maxCalls ?? 32)
  if (typeof options.authorize !== 'function') throw new Error('Bot host authorization is required')
  const authorize = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    await options.authorize(structuredClone({ bot, tool, args }), signal)
    signal.throwIfAborted()
  }
  await authorize(options.signal)
  const code = await bundle(files, tool)
  await authorize(options.signal)
  const result = await executeScript({
    code, args, entry: 'run', signal: options.signal,
    policy: { kind: 'restricted', imports: [...tool.imports, '@shadow/bot-runtime'] },
    timeoutMs, maxCalls,
    callModule: async (name, input, signal) => {
      await authorize(signal)
      if (name !== 'bot-runtime') {
        if (!tool.imports.includes(`@shadow/${name}`) || !options.callModule) throw new Error('Bot module capability denied')
        return await options.callModule(name, input, signal)
      }
      const request = requestSchema.parse(input)
      if (request.kind === 'services' && options.services) return await options.services(request.name, request.input, signal)
      if (request.kind === 'channel' && options.channel) return await options.channel(request.name, request.input, signal)
      if (request.kind === 'storage' && options.storage) {
        const operation = z.enum(['get', 'set', 'delete']).parse(request.name)
        const value = operation === 'set'
          ? z.object({ key: keySchema, value: z.unknown().refine(v => v !== undefined) }).strict().parse(request.input)
          : z.object({ key: keySchema }).strict().parse(request.input)
        return await options.storage(operation, value, signal)
      }
      if (request.kind === 'log' && options.log) {
        const level = z.enum(['info', 'warn', 'error']).parse(request.name)
        const { message } = z.object({ message: z.string().max(4096) }).strict().parse(request.input)
        await options.log(level, message, signal)
        return null
      }
      throw new Error('Bot context capability denied')
    },
  })
  return result.value
}
