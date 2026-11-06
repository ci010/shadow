import type { ProviderDefinition } from './contracts.ts'

// Four independent connections per request, never a global cursor over mixed repositories.
const fields = Array.from({ length: 4 }, (_, i) => `r${i}: repository(owner:$o${i},name:$n${i}) @include(if:$use${i}) { issues(first:50,after:$c${i},orderBy:{field:CREATED_AT,direction:ASC}) { nodes { id number title url updatedAt state } pageInfo { hasNextPage endCursor } } }`).join('\n')
const variables = Array.from({ length: 4 }, (_, i) => `$o${i}:String!,$n${i}:String!,$c${i}:String,$use${i}:Boolean!`).join(',')
export const githubDefinition: ProviderDefinition = {
  id: 'github-issues', version: 1, stateVersion: 'snapshot-v1',
  description: 'GraphQL repository issue snapshots; exact repository demands deduplicated and up to four connections batched. Silent initial snapshot. Requires metadata/issues read PAT. Bounded to 500 issues/repository; larger repositories fail closed. No PRs, comments, deletions or live guarantees.',
  demandSchema: { type: 'object', required: ['repository'], additionalProperties: false, properties: { repository: { type: 'string' } } },
  eventSchema: { type: 'object', required: ['id', 'updatedAt', 'title'], properties: { id: { type: 'string' }, updatedAt: { type: 'string' }, title: { type: 'string' } } },
  examples: [{ demand: { repository: 'owner/repo' }, event: { id: 'issue-1:2026-01-01T00:00:00Z', data: { id: 'issue-1', updatedAt: '2026-01-01T00:00:00Z', title: 'Example issue' } } }],
  queries: [`query ShadowIssueSnapshots(${variables}) { ${fields} }`],
  code: `export async function run({demands,queries}) {
    const result = {};
    for (let offset=0; offset<demands.length; offset+=4) {
      const batch=demands.slice(offset,offset+4);
      const cursors=batch.map(()=>null), done=batch.map(()=>false), events=batch.map(()=>[]), seen=batch.map(()=>new Set());
      for(let page=0;page<10 && done.some(v=>!v);page++) {
        const variables={};
        for(let i=0;i<4;i++) {
          const parts=(batch[i]?.demand.repository || 'unused/unused').split('/');
          variables['o'+i]=parts[0]; variables['n'+i]=parts[1]; variables['c'+i]=cursors[i]||null; variables['use'+i]=!!batch[i]&&!done[i];
        }
        const data=await fetch({query:queries[0],variables});
        for(let i=0;i<batch.length;i++) {
          if(done[i]) continue;
          const connection=data['r'+i]?.issues;
          if(!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error('incomplete repository');
          for(const node of connection.nodes) {
            if(!node || typeof node.id!=='string' || typeof node.updatedAt!=='string' || seen[i].has(node.id)) throw new Error('invalid or overlapping page');
            seen[i].add(node.id); events[i].push({id:node.id+':'+node.updatedAt,data:node});
          }
          if(events[i].length>500) throw new Error('snapshot bound exceeded');
          const info=connection.pageInfo;
          if(typeof info.hasNextPage!=='boolean') throw new Error('invalid page');
          if(info.hasNextPage && (!info.endCursor || info.endCursor===cursors[i] || !connection.nodes.length)) throw new Error('cursor did not advance');
          cursors[i]=info.endCursor; done[i]=!info.hasNextPage;
        }
      }
      if(done.some(v=>!v)) throw new Error('pagination bound exceeded');
      for(let i=0;i<batch.length;i++) result[batch[i].key]={events:events[i],checkpoint:null};
    }
    return result;
  }`.replace('export async function run', "import { call as fetch } from '@shadow/fetch';\nexport async function run"),
}
