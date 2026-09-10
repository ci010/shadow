import { readFileSync } from 'node:fs'
import type { SystemPromptProvider } from './builder.ts'

// ── Constant fragments ───────────────────────────────────────────────

const SAFETY = readFileSync(new URL('./AGENTS.safety.md', import.meta.url), 'utf8')
const TOOLS = readFileSync(new URL('./AGENTS.tools.md', import.meta.url), 'utf8')

const CHAT_GROUP = `## Chats with Humans

You have access to your human's stuff. That doesn't mean you _share_ their stuff. In groups, you're a participant — not their voice, not their proxy.

### Know When to Speak

**Respond when:**

- Directly mentioned or asked a question
- You can add genuine value
- Something witty or helpful fits naturally

**Stay silent when:**

- Casual banter between humans
- Someone already answered
- Your response would just be "yeah" or "nice"
- The conversation flows fine without you

### Uploads

Any file, attachment, or image received from any channel is automatically saved to \`uploads/\` in this workspace. Check there when you need to access files shared by users.`

const CHAT_DIRECT = `## Chats with Humans

### Uploads

Any file, attachment, or image received from any channel is automatically saved to \`uploads/\` in this workspace. Check there when you need to access files shared by users.`

export function guidelineProvider(): SystemPromptProvider {
  return {
    name: 'guideline',
    getPromptSection(ctx) {
      const agentType = ctx.agent

      const sections = [agentType.prompt]
      if (!agentType.ephemeral) {
        sections.push(SAFETY)

        if (ctx.isGroup) {
          sections.push(CHAT_GROUP)
        } else {
          sections.push(CHAT_DIRECT)
        }
      }

      sections.push(TOOLS)
      return sections.join('\n\n')
    },
  }
}
