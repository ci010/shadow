import { createRouter, createWebHashHistory, createWebHistory, type RouteRecordRaw } from 'vue-router'
import LogsTab from './components/LogsTab.vue'
import SpansTab from './components/SpansTab.vue'
import ProjectsWorkspace from './components/ProjectsWorkspace.vue'
import AgentsTab from './components/AgentsTab.vue'
import NodesView from './components/NodesView.vue'
import SettingsView from './components/SettingsView.vue'
import ProjectSettings from './components/ProjectSettings.vue'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  { path: '/chat/:sessionId?', redirect: to => ({ name: 'chat', params: { projectId: 'default', sessionId: to.params.sessionId }, query: to.query }) },
  { path: '/projects/:projectId/chat/:sessionId?', name: 'chat', component: ProjectsWorkspace },
  { path: '/projects', name: 'projects', component: ProjectsWorkspace },
  { path: '/knowledge', redirect: '/projects/default/knowledge' },
  { path: '/projects/:projectId/knowledge', name: 'knowledge', redirect: to => ({
    name: 'chat', params: { projectId: to.params.projectId }, query: { ...to.query, panel: 'knowledge' }, hash: to.hash,
  }) },
  { path: '/projects/:projectId/settings/:section(general|models|bots|learning)?', name: 'project-settings', component: ProjectSettings },
  { path: '/workspaces', redirect: '/nodes' },
  { path: '/nodes', name: 'nodes', component: NodesView },
  { path: '/providers', name: 'providers', redirect: '/settings/providers' },
  { path: '/settings/channels', redirect: '/projects/default/settings/bots' },
  { path: '/settings/:section(providers|models)?', name: 'settings', component: SettingsView },
  { path: '/approvals', redirect: '/nodes' },
  { path: '/agents/:agentName?', redirect: to => ({ name: 'agents', params: { projectId: 'default', agentName: to.params.agentName } }) },
  { path: '/projects/:projectId/agents/:agentName?', name: 'agents', component: AgentsTab },
  { path: '/spans', redirect: '/projects/default/spans' },
  { path: '/projects/:projectId/spans', name: 'spans', component: SpansTab },
  { path: '/logs', redirect: '/projects/default/logs' },
  { path: '/projects/:projectId/logs', name: 'logs', component: LogsTab },
]

const router = createRouter({
  history: location.protocol === 'file:' ? createWebHashHistory() : createWebHistory(),
  routes,
})

export default router
