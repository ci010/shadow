import { createApp, h } from 'vue'
import DisplaySourcePicker from '../components/io/DisplaySourcePicker.vue'
import { desktopMediaBridge } from './desktop.ts'
import '../styles.css'

const fixture = window as unknown as {
  pickerDuration: number
  pickerResult: string
  pickerRun: string
}
fixture.pickerDuration = 60_000
let sequence = 0
createApp({
  render: () => h('main', { style: 'padding:24px' }, [
    h('button', {
      id: 'start',
      async onClick() {
        fixture.pickerRun = `picker-${++sequence}`
        fixture.pickerResult = 'pending'
        try {
          await desktopMediaBridge()!.arm({ runId: fixture.pickerRun, capabilities: ['screen'], durationMs: fixture.pickerDuration })
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
          stream.getTracks().forEach(track => track.stop())
          fixture.pickerResult = 'unexpected-acquisition'
        } catch (cause) { fixture.pickerResult = cause instanceof Error ? cause.name : String(cause) }
      },
    }, 'Start capture'),
    h(DisplaySourcePicker),
  ]),
}).mount('#app')
