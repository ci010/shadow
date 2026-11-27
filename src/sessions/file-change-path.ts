export const SELF_EDIT_PATCH_ROUTE = 'self/edits/'

export function sessionEditPatchPath(editId: string): string {
  return `v:sessions/${SELF_EDIT_PATCH_ROUTE}${encodeURIComponent(editId)}`
}
