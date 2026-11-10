import { z } from 'zod'
import type { ProviderDefinition } from './contracts.ts'

// Four independent connections per request, never a global cursor over mixed repositories.
const fields = Array.from({ length: 4 }, (_, i) => `r${i}: repository(owner:$o${i},name:$n${i}) @include(if:$use${i}) { issues(first:50,after:$c${i},orderBy:{field:CREATED_AT,direction:ASC}) { nodes { id number title url updatedAt state } pageInfo { hasNextPage endCursor } } }`).join('\n')
const variables = Array.from({ length: 4 }, (_, i) => `$o${i}:String!,$n${i}:String!,$c${i}:String,$use${i}:Boolean!`).join(',')
const query = `query ShadowIssueSnapshots(${variables}) { ${fields} }`

export const normalizeGithubDemand = (demand: unknown): unknown => z.object({ repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/).transform(s => s.toLowerCase()) }).strict().parse(demand)

export const githubDefinition: ProviderDefinition = {
  id: 'github-issues', version: 1, stateVersion: 'snapshot-v1',
  description: 'GraphQL repository issue snapshots; exact repository demands deduplicated and up to four connections batched. Silent initial snapshot. Requires metadata/issues read PAT. Bounded to 500 issues/repository; larger repositories fail closed. No PRs, comments, deletions or live guarantees.',
  consumer: {
    summary: 'Observe new and updated repository issues.',
    unsupported: 'No PRs, comments, deletions, guaranteed transitions or live guarantees; at most 500 issues/repository.',
    capabilities: ['Repository issue revisions with number, title, URL, state, update time and stable issue ID.'],
    limitations: ['No pull requests, comments, deletions or live guarantees.', 'At most 500 issues per repository; larger sources fail without advancing the baseline.', 'Observed revisions are not a guaranteed history of state transitions; intermediate changes between polls may be missed.'],
    semantics: ['An occurrence ID combines issue ID and updatedAt. An observed new revision emits once relative to the preceding successful snapshot.'],
  },
  demandSchema: { type: 'object', required: ['repository'], additionalProperties: false, properties: { repository: { type: 'string', description: 'owner/name; owner uses letters, digits, underscore or hyphen; name also permits dots. Normalized to lowercase.' } } },
  signalSchema: { type: 'object', required: ['id', 'number', 'title', 'url', 'state', 'updatedAt'], additionalProperties: false, properties: {
    id: { type: 'string' }, number: { type: 'integer', minimum: 1 }, title: { type: 'string' }, url: { type: 'string' }, state: { enum: ['OPEN', 'CLOSED'] }, updatedAt: { type: 'string' },
  } },
  examples: [{ demand: { repository: 'owner/repo' }, signal: { id: 'issue-1:2026-01-01T00:00:00Z', data: { id: 'issue-1', number: 1, title: 'Example issue', url: 'https://github.com/owner/repo/issues/1', state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z' } } }],
  // This trusted GitHub-owned assertion is constrained by an exact static query.
  http: { origin: 'https://api.github.com', credential: { header: 'Authorization', prefix: 'Bearer ' },
    routes: [{ method: 'POST', path: '/graphql', effect: 'read', querySchema: { type: 'object', additionalProperties: false },
      bodySchema: { type: 'object', required: ['query', 'variables'], additionalProperties: false,
        properties: { query: { const: query }, variables: { type: 'object' } } } }] },
  code: `export async function run({demands}) {
    const query = ${JSON.stringify(query)};
    const result = {};
    for (let offset=0; offset<demands.length; offset+=4) {
      const batch=demands.slice(offset,offset+4);
      const cursors=batch.map(()=>null), done=batch.map(()=>false), signals=batch.map(()=>[]), seen=batch.map(()=>new Set());
      for(let page=0;page<10 && done.some(v=>!v);page++) {
        const variables={};
        for(let i=0;i<4;i++) {
          const parts=(batch[i]?.demand.repository || 'unused/unused').split('/');
          variables['o'+i]=parts[0]; variables['n'+i]=parts[1]; variables['c'+i]=cursors[i]||null; variables['use'+i]=!!batch[i]&&!done[i];
        }
        const response=await call({method:'POST',path:'/graphql',body:{query,variables}});
        const body=response.body;
        if(response.status!==200 || !body || body.errors!==undefined || !body.data) throw new Error('GraphQL response failed or partial');
        const data=body.data;
        for(let i=0;i<batch.length;i++) {
          if(done[i]) continue;
          const connection=data['r'+i]?.issues;
          if(!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error('incomplete repository');
          for(const node of connection.nodes) {
            if(!node || typeof node.id!=='string' || typeof node.updatedAt!=='string' || !Number.isInteger(node.number) || node.number<1 || typeof node.title!=='string' || typeof node.url!=='string' || !['OPEN','CLOSED'].includes(node.state) || seen[i].has(node.id)) throw new Error('invalid or overlapping page');
            seen[i].add(node.id); signals[i].push({id:node.id+':'+node.updatedAt,data:{id:node.id,number:node.number,title:node.title,url:node.url,state:node.state,updatedAt:node.updatedAt}});
          }
          if(signals[i].length>500) throw new Error('snapshot bound exceeded');
          const info=connection.pageInfo;
          if(typeof info.hasNextPage!=='boolean') throw new Error('invalid page');
          if(info.hasNextPage && (!info.endCursor || info.endCursor===cursors[i] || !connection.nodes.length)) throw new Error('cursor did not advance');
          cursors[i]=info.endCursor; done[i]=!info.hasNextPage;
        }
      }
      if(done.some(v=>!v)) throw new Error('pagination bound exceeded');
      for(let i=0;i<batch.length;i++) result[batch[i].key]={signals:signals[i],checkpoint:null};
    }
    return result;
  }`.replace('export async function run', "import { call } from '@shadow/fetch';\nexport async function run"),
}

/** Built-in registration; generic runtime does not interpret repository demands. */
export const githubProvider = { definition: githubDefinition, normalize: normalizeGithubDemand }
