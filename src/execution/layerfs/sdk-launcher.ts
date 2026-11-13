
/** Generated private launcher: ordinary exec owns its output, exit code and cancellation.
 * This is a transport adapter, not a Git/Docker/import workflow. */
export function sdkLauncher(profile: { port: number; token: string; sdkModule: string }) {
  return `import { pathToFileURL } from 'node:url';
const profile = ${JSON.stringify(profile)};
async function request(action, input) {
 const response = await fetch('http://127.0.0.1:' + profile.port, {method:'POST', headers:{authorization:'Bearer ' + profile.token, 'content-type':'application/json'}, body:JSON.stringify({action,input})});
 const receipt = await response.json();
 if (!response.ok || receipt.ok !== true) throw Error('LayerFS owner refused or outcome unknown: ' + (receipt.code ?? 'Unknown') + ': ' + (receipt.message ?? '') + '; inspect before retrying');
 return receipt.result;
}
const runtime = Object.freeze({project:Object.freeze(Object.fromEntries(['list','start_init','get_init'].map(method => [method, (...args) => request('official_project', {method,args})])))});
let opened;
async function open(project) {
 if (opened) throw Error('One SDK client/project per launcher process; use another exec invocation');
 opened = true;
 const config = await request('configuration', {project});
 for (const key of Object.keys(process.env)) if (key.startsWith('LAYERFS_')) delete process.env[key];
 for (const [key,value] of Object.entries(config.env)) process.env[key] = value;
 const { LayerFS } = await import(pathToFileURL(profile.sdkModule).href);
 return LayerFS.open(project);
}
// Own the script failure boundary explicitly on both Node and Electron's
// run-as-node entrypoint; retain the error stack and never reset a failing exit.
try {
const script = process.argv[2];
if (!script) throw Error('Usage: node launcher.mjs <absolute-script.mjs> [args...]');
const { default: main } = await import(pathToFileURL(script).href);
if (typeof main !== 'function') throw Error('Script must export default async ({runtime,open,args}) => {...}');
await main(Object.freeze({runtime,open,args:process.argv.slice(3)}));
} catch (error) {
 process.exitCode = 1;
 console.error(error);
}
`
}

