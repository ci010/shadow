export function projectIds(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('projects' in value) || !Array.isArray(value.projects)) {
    throw new Error('Invalid project activity catalog')
  }
  const ids = value.projects.map((project: unknown) => {
    if (typeof project !== 'object' || project === null || !('id' in project)
      || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.id)) {
      throw new Error('Invalid project activity identity')
    }
    return project.id
  })
  return [...new Set(ids)]
}
