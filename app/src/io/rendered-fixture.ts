import { createApp, defineComponent, h, ref } from 'vue'
import IoHost from '../components/io/IoHost.vue'
import IoRequestCard from '../components/io/IoRequestCard.vue'
import { createIoBridge, ioBridgeKey } from './bridge.ts'
import { useIoConversation } from './conversation.ts'
import '../styles.css'
document.documentElement.classList.add('dark')

const streams: MediaStream[] = []
const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
// Chromium's fake backend may expose only default; the USB option routes to that fake, never hardware.
navigator.mediaDevices.enumerateDevices = async () => {
  const devices = await enumerate()
  if (!streams.some(stream => stream.getAudioTracks().some(track => track.readyState === 'live'))) return devices
  const device = (deviceId: string, label: string): MediaDeviceInfo => ({
    deviceId, label, groupId: 'synthetic', kind: 'audioinput',
    toJSON: () => ({ deviceId, label, groupId: 'synthetic', kind: 'audioinput' }),
  })
  return [...devices.filter(item => item.kind !== 'audioinput'), device('default', 'Default microphone'), device('fixture-usb', 'USB microphone (synthetic)'), device('fixture-denied', 'Unavailable microphone (synthetic)')]
}
navigator.mediaDevices.getUserMedia = async constraints => {
  const audio = constraints?.audio
  const selected = typeof audio === 'object' && typeof audio.deviceId === 'object' && audio.deviceId !== null && 'exact' in audio.deviceId ? audio.deviceId.exact : undefined
  if (selected === 'fixture-denied') throw new DOMException('Synthetic input device unavailable', 'NotFoundError')
  const stream = await acquire(selected === 'fixture-usb' ? { ...constraints, audio: { ...(typeof audio === 'object' ? audio : {}), deviceId: undefined } } : constraints)
  if (selected === 'fixture-usb') for (const track of stream.getAudioTracks()) {
    const settings = track.getSettings.bind(track)
    track.getSettings = () => ({ ...settings(), deviceId: selected })
  }
  streams.push(stream)
  return stream
}
Object.defineProperty(window, '__ioSmoke', { value: {
  get acquired() { return streams.length },
  get liveTracks() { return streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length },
} })
const bridge = createIoBridge()
const base = `${location.origin}/projects/default/`
const session = ref('web:chat-smoke')
const Conversation = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    const messages = [
      { role: 'user', timestamp: '2020-01-01T00:00:00Z' },
      { role: 'assistant', timestamp: '2020-01-01T00:00:01Z' },
    ]
    const { after, earlier, error } = useIoConversation(
      () => ({ apiBase: base, sessionId: props.sessionId, remote: false, projectId: 'default' }),
      () => messages,
    )
    return () => h('main', { class: 'chat-messages', style: 'padding:20px;max-width:820px;margin:auto;' }, [
      h('p', 'Can you listen to this sound?'),
      h('p', 'Record a short sample when you are ready.'),
      ...[...after.value.values()].flat().map(run => h(IoRequestCard, { key: run.id, run, base })),
      ...earlier.value.map(run => h(IoRequestCard, { key: run.id, run, base })),
      error.value ? h('p', { role: 'alert' }, error.value) : null,
    ])
  },
})
const app = createApp({ render: () => [
  h('button', { onClick: () => { session.value = 'web:other' } }, 'Other conversation'),
  h(IoHost, { bridge, onOpenConversation: (context: { sessionId: string }) => { session.value = context.sessionId } }),
  h(Conversation, { key: session.value, sessionId: session.value }),
] })
app.provide(ioBridgeKey, bridge)
app.provide(Symbol.for('shadow.live-client-pool'), { client: () => ({ subscribe: () => ({ close() {}, ready: async () => {} }) }) })
app.mount('#app')
