export type Value = string | number | null | { actor: true }
export type Condition = { column: string; operator: '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' | 'IS' | 'IS NOT'; value: Value }
export type Statement = {
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  columns?: string[]
  values?: Value[]
  assignments?: Record<string, Value>
  where: Condition[]
  order?: { column: string; direction: 'ASC' | 'DESC' }
  limit?: number
}

type Token = { kind: 'word' | 'string' | 'number' | 'symbol'; text: string }

// Tokenize and parse a closed grammar, never pass user SQL to SQLite.
export function parseSql(sql: string): Statement[] {
  if (!sql.trim() || Buffer.byteLength(sql) > 65_536) throw new Error('SQL must be nonempty and at most 65536 bytes')
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const char = sql[i]!
    if (/\s/.test(char)) { i++; continue }
    if (char === "'") {
      let text = ''
      let closed = false
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          i++
          if (sql[i] === "'") { text += "'"; i++; continue }
          closed = true
          break
        }
        text += sql[i++]
      }
      if (!closed) throw new Error('Unterminated SQL string')
      tokens.push({ kind: 'string', text })
    } else if (/[a-zA-Z_]/.test(char)) {
      const start = i++
      while (i < sql.length && /[a-zA-Z0-9_]/.test(sql[i]!)) i++
      tokens.push({ kind: 'word', text: sql.slice(start, i).toLowerCase() })
    } else if (/[0-9-]/.test(char)) {
      const start = i++
      while (i < sql.length && /[0-9]/.test(sql[i]!)) i++
      const text = sql.slice(start, i)
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('Expected safe integer')
      tokens.push({ kind: 'number', text })
    } else if ('(),;*=!<>'.includes(char)) {
      let text = sql[i++]!
      if ('!<>'.includes(text) && sql[i] === '=') text += sql[i++]
      else if (text === '<' && sql[i] === '>') text += sql[i++]
      tokens.push({ kind: 'symbol', text })
    } else {
      throw new Error(`Unsupported SQL token at offset ${i}`)
    }
    if (tokens.length > 4096) throw new Error('SQL token limit exceeded')
  }
  let cursor = 0
  const peek = (text: string) => tokens[cursor]?.text === text && tokens[cursor]?.kind !== 'string'
  const take = (text: string) => {
    if (!peek(text)) throw new Error(`Expected ${text}`)
    cursor++
  }
  const identifier = () => {
    const token = tokens[cursor++]
    if (token?.kind !== 'word') throw new Error('Expected unquoted identifier')
    return token.text
  }
  const value = (): Value => {
    const token = tokens[cursor++]
    if (token?.kind === 'string') return token.text
    if (token?.kind === 'number') return Number(token.text)
    if (token?.kind === 'word' && token.text === 'null') return null
    if (token?.kind === 'word' && token.text === 'actor_session_id') {
      take('('); take(')')
      return { actor: true }
    }
    throw new Error('Expected string, integer, NULL, or actor_session_id()')
  }
  const list = <T>(read: () => T): T[] => {
    const result = [read()]
    while (peek(',')) { take(','); result.push(read()) }
    return result
  }
  const result: Statement[] = []
  while (cursor < tokens.length) {
    const operation = identifier().toUpperCase() as Statement['operation']
    let statement: Statement
    if (operation === 'SELECT') {
      const columns = peek('*') ? (take('*'), ['*']) : list(identifier)
      take('from')
      statement = { operation, table: identifier(), columns, where: [] }
    } else if (operation === 'INSERT') {
      take('into')
      const table = identifier()
      take('(')
      const columns = list(identifier)
      take(')'); take('values'); take('(')
      const values = list(value)
      take(')')
      if (columns.length !== values.length || new Set(columns).size !== columns.length) throw new Error('Invalid INSERT columns/values')
      statement = { operation, table, columns, values, where: [] }
    } else if (operation === 'UPDATE') {
      const table = identifier()
      take('set')
      const assignments: Record<string, Value> = Object.create(null)
      list(() => {
        const column = identifier()
        if (Object.hasOwn(assignments, column)) throw new Error('Duplicate assignment')
        take('=')
        assignments[column] = value()
      })
      statement = { operation, table, assignments, where: [] }
    } else if (operation === 'DELETE') {
      take('from')
      statement = { operation, table: identifier(), where: [] }
    } else {
      throw new Error('Only constrained SELECT, INSERT, UPDATE, DELETE are supported')
    }
    if (operation !== 'INSERT' && peek('where')) {
      take('where')
      do {
        if (statement.where.length) take('and')
        const column = identifier()
        let operator = tokens[cursor++]?.text.toUpperCase()
        if (operator === 'IS' && peek('not')) { take('not'); operator = 'IS NOT' }
        if (!['=', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT'].includes(operator ?? '')) throw new Error('Unsupported WHERE operator')
        const literal = value()
        if ((operator === 'IS' || operator === 'IS NOT') && literal !== null) throw new Error('IS only supports NULL')
        statement.where.push({ column, operator: operator as Condition['operator'], value: literal })
      } while (peek('and'))
    }
    if (operation === 'SELECT') {
      if (peek('order')) {
        take('order'); take('by')
        const column = identifier()
        const direction = peek('desc') ? (take('desc'), 'DESC') : peek('asc') ? (take('asc'), 'ASC') : 'ASC'
        statement.order = { column, direction }
      }
      if (peek('limit')) {
        take('limit')
        const token = tokens[cursor++]
        if (token?.kind !== 'number' || Number(token.text) < 1 || Number(token.text) > 200) throw new Error('LIMIT must be 1..200')
        statement.limit = Number(token.text)
      }
    }
    if ((operation === 'UPDATE' || operation === 'DELETE') && !statement.where.length) throw new Error('Mutations require WHERE')
    if (cursor < tokens.length) take(';')
    result.push(statement)
    if (result.length > 20) throw new Error('At most 20 statements per query')
  }
  return result
}
