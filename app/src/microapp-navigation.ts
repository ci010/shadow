import type { RouteLocationNormalized } from 'vue-router'

/** App receipts point at author chats; the dashboard owns review and launch UI. */
export function microAppNavigation(to: RouteLocationNormalized) {
  if (to.name === 'chat' && typeof to.query.microApp === 'string' && /^[a-zA-Z0-9_-]+$/.test(to.query.microApp)) {
    return { name: 'project-dashboard', params: { projectId: to.params.projectId }, query: to.query }
  }
}
