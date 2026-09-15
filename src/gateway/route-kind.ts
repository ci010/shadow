export const SCOPED_BACKEND_PATTERN = '^/organizations/[^/]+/(?:api|v1|debug|eval|wechat|feishu|cluster|nodes|pair|local|host)(?:/|$)'

const scopedBackend = new RegExp(SCOPED_BACKEND_PATTERN)
const rootBackend = /^\/(?:api|v1|debug|eval|wechat|feishu|cluster)(?:\/|$)/
const hostBackend = /^\/(?:nodes|pair|local|host)\/v1(?:\/|$)/
const organizationPage = /^\/organizations\/[^/]+\/(?:chat(?:\/[^/]+)?|settings(?:\/(?:general|models|bots|learning))?|agents(?:\/[^/]+)?|logs|spans)\/?$/

export function isBackendPath(path: string): boolean {
  return rootBackend.test(path) || hostBackend.test(path) || scopedBackend.test(path)
}

export function isOrganizationPagePath(path: string): boolean {
  return organizationPage.test(path)
}
