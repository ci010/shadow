<template>
  <section class="bot-package" :aria-label="t('BOT deployments')">
    <h3>{{ t('BOT deployments') }}</h3>
    <p>{{ t('Edit BOT.md, bot.json and tool modules in a registered local Folder, then ask your Agent to deploy. One confirmation shows the summary and permission changes. Workspace edits never change a running deployment.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="loading" @click="refresh">{{ t('Refresh status') }}</button>
    <details v-for="item in pending" :key="item.revision"><summary>{{ t('Pending exact permissions and affected locations') }} · {{ item.revision.slice(0,12) }}</summary><pre>{{ JSON.stringify(item.facts,null,2) }}</pre></details>
    <p v-if="!loading && !deployments.length">{{ t('No directory BOT deployments.') }}</p>
    <article v-for="bot in deployments" :key="bot.id">
      <strong>{{ bot.id }}</strong>
      <p>{{ t('Source:') }} {{ bot.source.folderId }}/{{ bot.source.directory || '.' }}</p>
      <details><summary>{{ t('Deployment details') }}</summary>
        <p>{{ t('Revision:') }} {{ bot.revision }}</p>
        <p>{{ t('History:') }} {{ t(bot.mode === 'git' ? 'Internal isolated Git repository' : 'Current and previous only (Git unavailable)') }}</p>
        <p v-if="bot.previous">{{ t('Previous:') }} {{ bot.previous }}</p>
      </details>
    </article>
  </section>
</template>
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
const props = defineProps<{apiBase:string;projectId:string;active:boolean}>()
type Deployment = {id:string;revision:string;previous?:string;mode:'git'|'bounded';source:{folderId:string;directory:string}}
const pending=ref<Array<{revision:string;facts:unknown}>>([])
const deployments=ref<Deployment[]>([]),error=ref(''),loading=ref(false)
let generation=0
async function refresh(){
  const current=++generation
  if(!props.active)return
  loading.value=true;error.value=''
  try{
    const response=await fetch(apiUrl(props.apiBase,'/api/bot-package'))
    if(!response.ok)throw new Error(t('BOT deployment status unavailable.'))
    const data=await response.json()
    if(current===generation){deployments.value=data.deployments;pending.value=data.pending ?? []}
  }catch(e){if(current===generation)error.value=e instanceof Error?e.message:t('BOT deployment status unavailable.')}
  finally{if(current===generation)loading.value=false}
}
watch(()=>[props.apiBase,props.projectId,props.active],()=>{generation++;deployments.value=[];pending.value=[];error.value='';void refresh()},{immediate:true})
onBeforeUnmount(()=>{generation++})
</script>
<style scoped>
.bot-package { padding:16px; border:1px solid var(--c-border); border-radius:12px; margin-block:12px; overflow-wrap:anywhere; }
article { padding-block:12px; border-top:1px solid var(--c-border); }
p { color:var(--c-text-secondary); }
</style>
