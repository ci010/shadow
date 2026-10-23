import { z } from 'zod'
import { Script } from 'node:vm'
import { JsonSchema, ResourceName } from './contracts.ts'

// The original version-1 store used grant IDs and run(args, capabilities),
// before module imports and explicit agent module ceilings were introduced.
export const LegacyAuthoredToolSchema = z.object({
  source: z.string().regex(/^[a-zA-Z0-9_-]+\.js$/),
  description: z.string().min(1).max(2000),
  parameters: JsonSchema,
  capabilities: z.array(ResourceName).max(32),
}).strict()

export function legacyToolCode(code: string, capabilities: readonly string[]): string {
  try {
    // Parse the original script independently, without running it. Otherwise
    // malformed source could become valid only by changing the wrapper's scope.
    new Script(code)
  } catch {
    throw new Error('Legacy authored tools require valid JavaScript scripts with run(args, capabilities); recreate module-format tools with imports.')
  }
  const imports = capabilities.map((name, index) =>
    `import { call as capability${index} } from ${JSON.stringify(`@shadow/${name}`)};`)
  const cases = capabilities.map((name, index) =>
    `case ${JSON.stringify(name)}: return capability${index}(input);`)
  return `${imports.join('\n')}
const legacyRun = (() => {
${code}
if (typeof run !== "function") throw new Error("Legacy authored tool requires run(args, capabilities).");
return run;
})();
const capabilities = Object.freeze({
  async call(name, input) {
    switch (name) {
      ${cases.join('\n')}
      default: throw new Error("Legacy tool did not declare that capability.");
    }
  }
});
export async function run(args) { return legacyRun(args, capabilities); }
`
}
