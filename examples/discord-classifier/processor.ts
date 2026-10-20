import type { Processor } from '@shadow/input-processor'
// Compose with the four-image rule module first: confirmed metadata campaigns need no model.
// This standalone example classifies only the unusual "review:" path.
export const run: Processor = ({event,classification}) => {
  const content = String(event.data.content ?? '')
  if (!content.startsWith('review:')) return {action:'buffer'}
  if (!classification) return {action:'ignore',classify:true}
  if (classification.label === 'semanticwake') return {action:'emit',semantic:{type:'discord.suspected-promotion',data:{messageId:event.data.id,confidence:classification.confidence}}}
  return {action:classification.label === 'ignore' ? 'ignore' : 'buffer'}
}
