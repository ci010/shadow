import { createRouter, createWebHashHistory, createWebHistory, type RouteRecordRaw } from 'vue-router'
import LogsTab from './components/LogsTab.vue'
import SpansTab from './components/SpansTab.vue'
import OrganizationsWorkspace from './components/OrganizationsWorkspace.vue'
import AgentsTab from './components/AgentsTab.vue'
import NodesView from './components/NodesView.vue'
import SettingsView from './components/SettingsView.vue'
import OrganizationSettings from './components/OrganizationSettings.vue'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  { path: '/chat/:sessionId?', redirect: to => ({ name: 'chat', params: { organizationId: 'default', sessionId: to.params.sessionId }, query: to.query }) },
  { path: '/organizations/:organizationId/chat/:sessionId?', name: 'chat', component: OrganizationsWorkspace },
  { path: '/organizations', name: 'organizations', component: OrganizationsWorkspace },
  { path: '/organizations/:organizationId/settings/:section(general|models|bots|learning)?', name: 'organization-settings', component: OrganizationSettings },
  { path: '/workspaces', redirect: '/nodes' },
  { path: '/nodes', name: 'nodes', component: NodesView },
  { path: '/providers', name: 'providers', redirect: '/settings/providers' },
  { path: '/settings/channels', redirect: '/organizations/default/settings/bots' },
  { path: '/settings/:section(providers)?', name: 'settings', component: SettingsView },
  { path: '/approvals', name: 'approvals', redirect: '/nodes' },
  { path: '/agents/:agentName?', redirect: to => ({ name: 'agents', params: { organizationId: 'default', agentName: to.params.agentName } }) },
  { path: '/organizations/:organizationId/agents/:agentName?', name: 'agents', component: AgentsTab },
  { path: '/spans', redirect: '/organizations/default/spans' },
  { path: '/organizations/:organizationId/spans', name: 'spans', component: SpansTab },
  { path: '/logs', redirect: '/organizations/default/logs' },
  { path: '/organizations/:organizationId/logs', name: 'logs', component: LogsTab },
]

const router = createRouter({
  history: location.protocol === 'file:' ? createWebHashHistory() : createWebHistory(),
  routes,
})

export default router
