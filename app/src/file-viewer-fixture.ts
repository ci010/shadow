import { createApp, defineComponent, h, reactive } from 'vue'
import 'uno.css'
import './styles.css'
import FilePreviewModal from './components/files/FilePreviewModal.vue'
import { useTheme } from './composables/useTheme.ts'

const props = reactive({
  apiBase: location.origin,
  sessionId: 'web:viewer-fixture',
  dir: '',
  entry: { name: 'report.pdf', type: 'file' as const, ext: '.pdf', size: 1024, mtime: null },
  active: false,
  inline: true,
})
Object.assign(window, {
  viewerFixture: {
    open(name: string) {
      props.entry = { ...props.entry, name, ext: name.slice(name.lastIndexOf('.')) }
      props.active = true
    },
    pause() { props.active = false },
    toggleTheme: useTheme().toggleTheme,
  },
})
createApp(defineComponent({
  setup: () => () => h(FilePreviewModal, { ...props, style: 'height:100vh' }),
})).mount('#app')
