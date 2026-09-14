import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import LogsTab from './components/LogsTab.vue'
import SpansTab from './components/SpansTab.vue'
import ChatWorkspace from './components/ChatWorkspace.vue'
import AgentsTab from './components/AgentsTab.vue'
import NodesView from './components/NodesView.vue'
import ApprovalsView from './components/ApprovalsView.vue'
import SettingsView from './components/SettingsView.vue'

const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat/:sessionId?', name: 'chat', component: ChatWorkspace },
  { path: '/workspaces', redirect: '/nodes' },
  { path: '/nodes', name: 'nodes', component: NodesView },
  { path: '/providers', name: 'providers', redirect: '/settings/providers' },
  { path: '/settings/:section(providers|channels)?', name: 'settings', component: SettingsView },
  { path: '/approvals', name: 'approvals', component: ApprovalsView },
  { path: '/agents/:agentName?', name: 'agents', component: AgentsTab },
  { path: '/spans', name: 'spans', component: SpansTab },
  { path: '/logs', name: 'logs', component: LogsTab },
]

const router = createRouter({
  history: location.protocol === 'file:' ? createWebHashHistory() : createWebHistory(),
  routes,
})

export default router
