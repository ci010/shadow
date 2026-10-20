import type { Processor } from '@shadow/input-processor'
import { classifyText } from './rules.ts'

export const run: Processor = ({ event }) => classifyText(String(event.data.content ?? ''))
