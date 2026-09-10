import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import LogsTab from './components/LogsTab.vue'
import SpansTab from './components/SpansTab.vue'
import ChatTab from './components/ChatTab.vue'
import AgentsTab from './components/AgentsTab.vue'
import WorkspacesView from './components/WorkspacesView.vue'
import NodesView from './components/NodesView.vue'
import ApprovalsView from './components/ApprovalsView.vue'
import ProvidersView from './components/ProvidersView.vue'

const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat/:sessionId?', name: 'chat', component: ChatTab },
  { path: '/workspaces', name: 'workspaces', component: WorkspacesView },
  { path: '/nodes', name: 'nodes', component: NodesView },
  { path: '/providers', name: 'providers', component: ProvidersView },
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
