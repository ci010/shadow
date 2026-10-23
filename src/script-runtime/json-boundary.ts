import { types } from 'node:util'

export const MAX_JSON_BYTES = 256 * 1024

export function checkTextSize(value: string, label: string): void {
  if (value.length > MAX_JSON_BYTES || Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`Script ${label} exceeds the ${MAX_JSON_BYTES}-byte limit.`)
  }
}

/** Copy plain data without executing toJSON, getters, or proxy traps. */
export function encodeJson(
  value: unknown,
  label: string,
  objectOnly = false,
  realm?: { object: object; array: object },
): string {
  let nodes = 0
  let length = 0
  const ancestors = new Set<object>()
  const append = (text: string): string => {
    length += text.length
    if (length > MAX_JSON_BYTES) throw new Error(`Script ${label} exceeds the JSON size limit.`)
    return text
  }
  const encode = (entry: unknown, depth: number): string => {
    if (++nodes > 65_536 || depth > 100) throw new Error(`Script ${label} is too complex.`)
    if (entry === null) return append('null')
    if (typeof entry === 'boolean') return append(entry ? 'true' : 'false')
    if (typeof entry === 'number' && Number.isFinite(entry)) return append(JSON.stringify(entry))
    if (typeof entry === 'string') {
      checkTextSize(entry, label)
      return append(JSON.stringify(entry))
    }
    if (typeof entry !== 'object' || types.isProxy(entry)) {
      throw new Error(`Script ${label} must contain only finite JSON data.`)
    }
    const array = Array.isArray(entry)
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)
      && prototype !== (array ? realm?.array : realm?.object)) {
      throw new Error(`Script ${label} must contain only plain JSON data.`)
    }
    if (ancestors.has(entry) || Object.getOwnPropertySymbols(entry).length) {
      throw new Error(`Script ${label} must contain only acyclic JSON data.`)
    }
    ancestors.add(entry)
    const keys = Object.getOwnPropertyNames(entry)
    if (keys.length > 65_536) throw new Error(`Script ${label} is too complex.`)
    let text = append(array ? '[' : '{')
    const size = array ? entry.length : keys.length
    if (array && keys.length !== size + 1) {
      throw new Error(`Script ${label} must not contain sparse or extended arrays.`)
    }
    for (let index = 0; index < size; index++) {
      const key = array ? String(index) : keys[index]!
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error(`Script ${label} must contain only enumerable JSON data properties.`)
      }
      if (index) text += append(',')
      if (!array) {
        checkTextSize(key, label)
        text += append(JSON.stringify(key)) + append(':')
      }
      text += encode(descriptor.value, depth + 1)
    }
    ancestors.delete(entry)
    return text + append(array ? ']' : '}')
  }
  if (objectOnly && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`Script ${label} must be a JSON object.`)
  }
  const text = encode(value, 0)
  checkTextSize(text, label)
  return text
}

export function decodeJson(text: string, label: string, objectOnly = false): unknown {
  checkTextSize(text, label)
  const value: unknown = JSON.parse(text)
  encodeJson(value, label, objectOnly)
  return value
}
