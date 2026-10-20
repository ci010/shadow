// Runtime action-schema mirror for a plain-Node worker; equivalence is tested against contracts.ts.
import { z } from 'zod'

export const computerActions = ['invoke', 'set_value', 'toggle', 'select', 'scroll']
export const foregroundActions = ['click', 'move', 'drag', 'wheel', 'press_key', 'type_text']
export const computerActionKinds = [...computerActions, ...foregroundActions]
const elementId = z.string().regex(/^\d+$/)
const coordinate = z.number().int().min(0).max(1599)
const modifiers = z.array(z.enum(['CTRL', 'ALT', 'SHIFT'])).max(3)
  .refine(values => new Set(values).size === values.length, 'Duplicate modifiers are not supported').default([])
export const ComputerKeySchema = z.enum([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'ENTER', 'TAB', 'ESCAPE', 'SPACE', 'BACKSPACE', 'DELETE', 'INSERT',
  'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'ARROW_UP', 'ARROW_DOWN', 'ARROW_LEFT', 'ARROW_RIGHT',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
])
export const ComputerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invoke'), elementId: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('set_value'), elementId: z.string().regex(/^\d+$/),
    value: z.string().max(4000).refine(value => !value.includes('\0'), 'NUL is not supported') }).strict(),
  z.object({ kind: z.literal('toggle'), elementId: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('select'), elementId: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('scroll'), elementId: z.string().regex(/^\d+$/),
    direction: z.enum(['up', 'down', 'left', 'right']) }).strict(),
  z.object({ kind: z.literal('click'), x: coordinate, y: coordinate,
    button: z.enum(['left', 'right', 'middle']).default('left'), count: z.union([z.literal(1), z.literal(2)]).default(1), modifiers }).strict(),
  z.object({ kind: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal('drag'), x: coordinate, y: coordinate, toX: coordinate, toY: coordinate,
    durationMs: z.number().int().min(100).max(800).default(300), modifiers }).strict(),
  z.object({ kind: z.literal('wheel'), x: coordinate, y: coordinate,
    axis: z.enum(['vertical', 'horizontal']).default('vertical'),
    steps: z.number().int().min(-10).max(10).refine(value => value !== 0, 'Wheel steps must be nonzero'), modifiers }).strict(),
  z.object({ kind: z.literal('press_key'), elementId, key: ComputerKeySchema, modifiers }).strict(),
  z.object({ kind: z.literal('type_text'), elementId, text: z.string().min(1).max(1000)
    .refine(value => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u.test(value),
      'Use printable Unicode text; Enter and Tab require separate key actions') }).strict(),
]).superRefine((action, context) => {
  if (action.kind === 'drag' && action.x === action.toX && action.y === action.toY) {
    context.addIssue({ code: 'custom', message: 'Drag endpoints must differ' })
  }
  if (action.kind !== 'press_key') return
  const alt = action.modifiers.includes('ALT'), ctrl = action.modifiers.includes('CTRL')
  if (alt && ['TAB', 'ESCAPE', 'SPACE', 'F6'].includes(action.key)
    || ctrl && action.key === 'ESCAPE'
    || ctrl && alt && action.key === 'DELETE') {
    context.addIssue({ code: 'custom', message: 'System and window-switching shortcuts are not supported' })
  }
})
