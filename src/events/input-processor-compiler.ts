import { readFile, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { build } from 'esbuild'

export const processorTypes = `export type ProcessorEvent = {type:string;data:Record<string,unknown>};
export type Classification = {label:'ignore'|'buffer'|'semanticwake'|'unknown';confidence:number};
export type ProcessorInput = {classification?:Classification;event:ProcessorEvent;state:Record<string,unknown>|null;now:number};
export type ProcessorDecision = {action:'ignore'|'buffer'|'emit';classify?:boolean;state?:Record<string,unknown>|null;semantic?:{type:string;data:Record<string,unknown>}};
export type Processor = (input:ProcessorInput)=>ProcessorDecision|Promise<ProcessorDecision>;`
export type ProcessorSnapshot = { path: string; source: string; sha256: string }[]
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
/** Compiler and bundler consume only this frozen graph, never a filesystem resolver. */
export async function compileProcessor(root: string, filename: string) {
  const base = await realpath(root)
  const files = new Map<string, string>(), diagnostics: string[] = []
  let total = 0
  const inside = (name: string) => name !== '' && !name.split('/').includes('..') && !path.isAbsolute(name)
  async function load(name: string): Promise<void> {
    if (files.has(name)) return
    if (!inside(name) || !name.endsWith('.ts') || name.endsWith('.d.ts')) throw new Error('Only project-local .ts modules are permitted')
    let cursor = base
    for (const part of name.split('/')) {
      cursor = path.join(cursor, part)
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink modules are forbidden')
    }
    const resolved = await realpath(cursor)
    if (resolved !== path.resolve(base, name)) throw new Error('Module path escaped project root')
    const bytes = await readFile(resolved)
    total += bytes.length
    if (bytes.length > 64000 || total > 128000 || files.size >= 32) throw new Error('Processor dependency snapshot capacity exceeded (32 files / 128000 bytes)')
    const source = new TextDecoder('utf-8', {fatal:true}).decode(bytes)
    files.set(name, source)
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true)
    if (ast.referencedFiles.length || ast.typeReferenceDirectives.length || ast.libReferenceDirectives.length || ast.hasNoDefaultLib) diagnostics.push(`${name}: Triple-slash reference directives are forbidden`)
    const dependencies: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = node.moduleSpecifier
        if (!spec || !ts.isStringLiteral(spec)) diagnostics.push(`${name}: Invalid module specifier`)
        else if (spec.text === '@shadow/input-processor') {
          if (!ts.isImportDeclaration(node) || !node.importClause?.isTypeOnly) diagnostics.push(`${name}: SDK is type-only`)
        } else if (!spec.text.startsWith('./') && !spec.text.startsWith('../')) diagnostics.push(`${name}: Host/package modules are forbidden: ${spec.text}`)
        else {
          const dep = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec.text))
          if (spec.text.includes('\\') || !inside(dep) || !dep.endsWith('.ts')) diagnostics.push(`${name}: Dependencies require explicit project-local .ts paths`)
          else dependencies.push(dep)
        }
      }
      if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || node.kind === ts.SyntaxKind.ImportKeyword) diagnostics.push(`${name}: Dynamic imports/import-equals/import types are forbidden`)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const dep of dependencies) await load(dep)
  }
  if (path.isAbsolute(filename) || filename.includes('\\')) throw new Error('Use a relative project .ts path with forward slashes')
  const entry = path.posix.normalize(filename)
  if (!inside(entry)) throw new Error('Path outside workspace')
  try { await load(entry) } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)) }
  const snapshot: ProcessorSnapshot = [...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,source])=>({path,source,sha256:hash(source)}))
  const sha256 = hash(JSON.stringify(snapshot))
  const options: ts.CompilerOptions = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,strict:true,types:[],skipLibCheck:true,allowImportingTsExtensions:true,noEmit:true}
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host)
  const libDir = path.dirname(ts.getDefaultLibFilePath(options))
  const trusted = (name:string) => path.dirname(path.resolve(name)) === path.resolve(libDir) && /^lib\.[a-z0-9.]+\.d\.ts$/i.test(path.basename(name))
  const virtual = new Map([...files].map(([name,source])=>['/project/'+name,source]))
  virtual.set('/sdk.d.ts',processorTypes)
  virtual.set('/contract.ts',`import {run} from './project/${entry}'; import type {Processor} from '@shadow/input-processor'; const checked:Processor=run;`)
  host.getSourceFile = (name,version,onError,fresh) => virtual.has(name) ? ts.createSourceFile(name,virtual.get(name)!,version,true) : trusted(name) ? original(name,version,onError,fresh) : undefined
  host.fileExists = name => virtual.has(name) || trusted(name)
  const read = host.readFile.bind(host)
  host.readFile = name => virtual.get(name) ?? (trusted(name) ? read(name) : undefined)
  host.resolveTypeReferenceDirectives = names => names.map(()=>undefined)
  host.resolveModuleNames = (names,from) => names.map(name => {
    const resolvedFileName = name === '@shadow/input-processor' ? '/sdk.d.ts' : path.posix.normalize(path.posix.join(path.posix.dirname(from),name))
    return virtual.has(resolvedFileName) ? {resolvedFileName,extension:resolvedFileName.endsWith('.d.ts')?ts.Extension.Dts:ts.Extension.Ts} : undefined
  })
  if (!diagnostics.length) diagnostics.push(...ts.getPreEmitDiagnostics(ts.createProgram(['/contract.ts',...[...files.keys()].map(n=>'/project/'+n)],options,host)).map(d=>`${d.file?.fileName ?? 'processor'}: ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`))
  let code = ''
  if (!diagnostics.length) {
    try {
      const result = await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',plugins:[{name:'frozen-processor',setup(builder){
        builder.onResolve({filter:/.*/}, args=> {
          const name = args.kind === 'entry-point' ? path.posix.normalize(args.path) : path.posix.normalize(path.posix.join(path.posix.dirname(args.importer),args.path))
          if (!files.has(name)) return {errors:[{text:'Module outside frozen snapshot: '+args.path}]}
          return {path:name,namespace:'processor'}
        })
        builder.onLoad({filter:/.*/,namespace:'processor'},args=>({contents:files.get(args.path)!,loader:'ts'}))
      }}]})
      code = result.outputFiles[0]!.text
      if (code.length > 64000) { code=''; diagnostics.push('Bundled program exceeds 64000 characters') }
    } catch (error) { diagnostics.push(String(error)) }
  }
  return {ok:!diagnostics.length,diagnostics,source:files.get(entry) ?? '',snapshot,code,sha256,codeSha256:hash(code)}
}
