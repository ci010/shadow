export function botFiles(source = 'throw new Error("must not run at deploy")', overrides: Record<string, unknown> = {}): Record<string, string> {
  return {
    'BOT.md': '---\nid: demo\nconfig: bot.json\n---\nA helpful bot.',
    'bot.json': JSON.stringify({ mode: 'service', allowedModules: [], tools: [{ name: 'custom_tool', description: 'Custom tool', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, module: 'tools/main.ts', imports: [] }], bindings: [], ...overrides }),
    'tools/main.ts': source,
  }
}

