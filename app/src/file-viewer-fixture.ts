import { createApp, defineComponent, h, reactive, ref } from 'vue'
import 'uno.css'
import './styles.css'
import FilePreviewModal from './components/files/FilePreviewModal.vue'
import FileTreeNode from './components/files/FileTreeNode.vue'
import type { FileEntry } from './composables/useSessionFiles.ts'
import { useTheme } from './composables/useTheme.ts'

const props = reactive({
  apiBase: location.origin,
  sessionId: 'web:viewer-fixture',
  dir: '',
  entry: { name: 'report.pdf', type: 'file', ext: '.pdf', size: 1024, mtime: null } as FileEntry,
  active: false,
  inline: true,
})
const treeFile = ref('')
const treeEntry = (): FileEntry => ({ name: treeFile.value, type: 'file', ext: treeFile.value.slice(treeFile.value.lastIndexOf('.')), size: 1024, mtime: null })
Object.assign(window, {
  viewerFixture: {
    open(name: string) {
      treeFile.value = ''
      props.dir = ''
      props.entry = { name, type: 'file', ext: name.slice(name.lastIndexOf('.')), size: 1024, mtime: null }
      props.active = true
    },
    browse(name: string) { treeFile.value = name; props.active = false },
    pause() { props.active = false },
    toggleTheme: useTheme().toggleTheme,
  },
})
createApp(defineComponent({
  setup: () => () => h('div', { style: 'display:flex;height:100vh;min-width:0' }, [
    treeFile.value ? h('aside', { style: 'width:260px;max-width:45vw;flex-shrink:0;overflow:auto' }, [
      h(FileTreeNode, { key: treeFile.value, apiBase: props.apiBase, sessionId: props.sessionId,
        dir: '', depth: 0, entry: treeEntry(), onOpen: ({ path, entry }: { path: string; entry: FileEntry }) => {
          props.dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
          props.entry = entry
          props.active = true
        } }),
    ]) : null,
    props.active ? h(FilePreviewModal, { ...props, style: 'height:100vh;flex:1;min-width:0' }) : null,
  ]),
})).mount('#app')
