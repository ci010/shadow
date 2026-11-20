import { parse } from 'es-module-lexer/js';

function resolveLocal(base, request) {
  if (request.length > 240 || (!request.startsWith('./') && !request.startsWith('../'))) return;
  const path = base.split('/').slice(0, -1);
  for (const segment of request.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (!path.length) return;
      path.pop();
    } else {
      if (!/^[\p{L}\p{N}_. -]+$/u.test(segment)) return;
      path.push(segment);
    }
  }
  return path.join('/');
}

// Native static imports need an already-created URL. Dynamic literal imports
// use a private URL table populated before any authored module is evaluated.
export function compileSnapshot(files, makeUrl) {
  const registry = makeUrl(`let modules;
export const initialize = entries => { if (!modules) { const map = new Map(entries); modules = map.get.bind(map); } };
export const load = (name, options) => {
  const url = modules(name);
  if (!url) throw new Error('Unknown snapshot module');
  return import(url, options);
};`);
  const urls = new Map();
  const visiting = new Set();
  function visit(name) {
    if (urls.has(name)) return urls.get(name);
    if (visiting.has(name)) throw new Error(`Static import cycle: ${[...visiting, name].join(' -> ')}`);
    visiting.add(name);
    const source = files.get(name);
    let imports;
    try { [imports] = parse(source, name); }
    catch (error) { throw new Error(`Unable to parse ${name}: ${error.message}`); }
    const edits = [];
    const dynamicTargets = [];
    let suffix = 0;
    let alias;
    do { alias = `__shadowLoad${suffix++}`; } while (source.includes(alias));
    for (const { t, n, s, e, ss } of imports) {
      if (t === 3) continue; // import.meta
      if (t !== 1 && t !== 2) throw new Error(`Unsupported import syntax in ${name}`);
      if (n === undefined) throw new Error(`Dynamic import in ${name} requires a literal relative path`);
      const target = resolveLocal(name, n);
      if (!target) throw new Error(`Disallowed import ${JSON.stringify(n.slice(0, 240))} from ${name}`);
      if (!files.has(target)) throw new Error(`Missing snapshot module: ${target} (imported from ${name})`);
      if (t === 1) edits.push([s, e, visit(target)]);
      else {
        dynamicTargets.push(target);
        edits.push([ss, ss + 'import'.length, alias], [s, e, JSON.stringify(target)]);
      }
    }
    // Rebuild once to avoid quadratic slicing on modules with many imports.
    const chunks = [];
    let last = 0;
    for (const [start, end, value] of edits.sort((a, b) => a[0] - b[0])) {
      chunks.push(source.slice(last, start), value);
      last = end;
    }
    chunks.push(source.slice(last));
    if (dynamicTargets.length) chunks.push(`\nimport { load as ${alias} } from ${JSON.stringify(registry)};`);
    const url = makeUrl(chunks.join(''));
    urls.set(name, url);
    visiting.delete(name);
    for (const target of dynamicTargets) pending.add(target);
    return url;
  }
  const pending = new Set(['main.mjs']);
  for (const name of pending) visit(name);
  return { entry: urls.get('main.mjs'), registry, urls };
}
