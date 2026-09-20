export const SCOPED_BACKEND_PATTERN = '^/projects/[^/]+/(?:api|v1|debug|eval|wechat|feishu|cluster|nodes|pair|local|host)(?:/|$)'

const scopedBackend = new RegExp(SCOPED_BACKEND_PATTERN)
const rootBackend = /^\/(?:api|v1|debug|eval|wechat|feishu|cluster)(?:\/|$)/
const hostBackend = /^\/(?:nodes|pair|local|host)\/v1(?:\/|$)/
const projectPage = /^\/projects\/[^/]+\/(?:chat(?:\/[^/]+)?|settings(?:\/(?:general|models|bots|learning))?|agents(?:\/[^/]+)?|knowledge|logs|spans)\/?$/

export function isBackendPath(path: string): boolean {
  return rootBackend.test(path) || hostBackend.test(path) || scopedBackend.test(path)
}

export function isProjectPagePath(path: string): boolean {
  return projectPage.test(path)
}
