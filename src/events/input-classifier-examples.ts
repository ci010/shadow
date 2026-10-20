export const classifierExamplePolicy = {model:'REPLACE_WITH_CONFIGURED_MODEL',instructions:'Detect suspected promotional campaigns. Ordinary questions should buffer; acknowledgements ignore. Use semanticwake only for compelling suspicious promotion evidence; otherwise unknown. Attachment metadata is not image content.',fields:['content','attachments'],maxInputBytes:2000,maxTokens:128,maxRequests:5,maxWindowTokens:20000,windowMs:60000,deadlineMs:1000,minConfidence:0.95}
export const classifierExampleSource = `import type { Processor } from '@shadow/input-processor'
// Compose with the four-image rule module first: confirmed metadata campaigns need no model.
// This standalone example classifies only the unusual "review:" path.
export const run: Processor = ({event,classification}) => {
  const content = String(event.data.content ?? '')
  if (!content.startsWith('review:')) return {action:'buffer'}
  if (!classification) return {action:'ignore',classify:true}
  if (classification.label === 'semanticwake') return {action:'emit',semantic:{type:'discord.suspected-promotion',data:{messageId:event.data.id,confidence:classification.confidence}}}
  return {action:classification.label === 'ignore' ? 'ignore' : 'buffer'}
}
`
export const classifierExampleFixtures = JSON.stringify({delayMs:1000,classifier:{policy:classifierExamplePolicy,responses:['{"label":"semanticwake","confidence":0.99}','{"label":"semanticwake","confidence":0.2}']},steps:[{kind:'input',key:'scope',id:'1',event:{type:'discord.MESSAGE_CREATE',data:{id:'1',content:'review: suspected promotion'}}},{kind:'input',key:'scope',id:'2',event:{type:'discord.MESSAGE_CREATE',data:{id:'2',content:'review: unclear'}}},{kind:'input',key:'scope',id:'3',event:{type:'discord.MESSAGE_CREATE',data:{content:'ordinary question'}}},{kind:'advance',ms:1000}],expected:[{at:0,ids:['1'],semantic:{type:'discord.suspected-promotion',data:{messageId:'1',confidence:0.99}}},{at:1000,ids:['3']}]},null,2)
export const classifierExampleFiles = {'processor.ts':classifierExampleSource,'policy.json':JSON.stringify(classifierExamplePolicy,null,2),'fixtures.json':classifierExampleFixtures}
