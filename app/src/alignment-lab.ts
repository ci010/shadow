// Development-only entry: no router, authentication, backend, upload or agent loop.
import { createApp } from 'vue'
import 'uno.css'
import './styles.css'
import AlignmentLab from './components/alignment/AlignmentLab.vue'
import { i18n, initializeI18n } from './i18n.ts'

const stopLocalization = initializeI18n(window)
const app = createApp(AlignmentLab).use(i18n)
app.mount('#app')
if (import.meta.hot) import.meta.hot.dispose(() => { app.unmount(); stopLocalization() })
