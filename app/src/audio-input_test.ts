import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audioEntry, pcmWav, recognizedTranscript } from './audio-input.ts'

test('ASR selected route, not TTS or conversation history, controls composer entry', () => {
  const tts = { ready: true, route: 'local' as const }
  assert.equal(audioEntry({ asr: { ready: false, route: 'local' }, tts }), 'setup')
  assert.equal(audioEntry({ asr: { ready: true, route: 'local' }, tts }), 'local-ready')
  assert.equal(audioEntry({ asr: { ready: true, route: 'remote' }, tts }), 'remote-ready')
})
test('microphone PCM produces mono PCM16 WAV with clamped samples', async () => {
  const wav = pcmWav(new Float32Array([-2, 0, 2]), 16000)
  const bytes = new DataView(await wav.arrayBuffer())
  assert.equal(wav.type, 'audio/wav'); assert.equal(wav.size, 50)
  assert.equal(bytes.getUint32(24, true), 16000)
  assert.equal(bytes.getUint16(22, true), 1)
  assert.equal(bytes.getInt16(44, true), -32768)
  assert.equal(bytes.getInt16(48, true), 32767)
})

test('ASR punctuation/whitespace artifacts are empty without filtering scripts or symbols', () => {
  for (const text of ['', ' \t\r\n\u3000', '.', '。', ' ...!? ,;:—“”()[] ', '，。！？：；、（）【】「」…\u3000']) {
    assert.equal(recognizedTranscript(text), '', JSON.stringify(text))
  }
  for (const text of ['你好。', 'Hello, world!', '123', '１２３。', 'العربية', '日本語', '$ + =', '🎵', '  hello.  ']) {
    assert.equal(recognizedTranscript(text), text.trim())
  }
})
