import type { PresentationSource } from '../projects/presentation-contract.ts'
export const voiceEvidence: PresentationSource[] = [
  { sessionId: 'web:chat-voice', physicalId: 'voice.0', id: 'record:0', kind: 'human', text: '希望增加语音功能，先讨论微信输入法或第三方输入法。' },
  { sessionId: 'web:chat-voice', physicalId: 'voice.0', id: 'record:1', kind: 'assistant', text: '输入法可把语音转文字，但受第三方依赖影响；也可以使用本地 ASR。' },
  { sessionId: 'web:chat-voice', physicalId: 'voice.0', id: 'record:2', kind: 'human', text: '微信输入法和第三方输入法方向先放弃。改做本地 ASR，不依赖输入法。' },
  { sessionId: 'web:chat-voice', physicalId: 'voice.1', id: 'record:0', kind: 'assistant', text: '本地 ASR 录音、识别与文本输入连接已实现；合成样本测试通过。没有调用第三方输入法。' },
]
const ref = (i: number) => { const { sessionId, physicalId, id } = voiceEvidence[i]!; return { sessionId, physicalId, id } }
export const voiceGroups = [{ category: '语音功能', purpose: '让用户通过语音输入', motivation: '希望减少打字', topicKeys: ['topic:web:chat-voice'], cards: [
  { id: 'ime-option', title: '微信或第三方输入法方案', state: 'abandoned' as const, markdown: '**为什么**：减少打字。\n\n**做了什么**：讨论输入法集成，用户明确暂时放弃。\n\n**如何**：保留讨论，不继续第三方依赖方向。', sources: [ref(0), ref(1), ref(2)], stateSources: [ref(2)] },
  { id: 'local-asr', title: '本地语音识别输入', state: 'reported_complete' as const, markdown: '**为什么**：避免第三方输入法依赖。\n\n**做了什么**：实现录音、识别和文本输入连接。\n\n**如何**：模型选择本地 ASR；最终报告称合成测试通过，尚无独立验收证据。', sources: [ref(2), ref(3)], stateSources: [ref(3)] },
] }]
