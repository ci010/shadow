<template>
  <section class="channel-index" :aria-label="t('Channel content')">
    <header><h2>{{ channelName }}</h2><p>{{ t('Choose a post or thread to open its original history.') }}</p></header>
    <label class="channel-search">{{ t('Search posts and threads') }}<input v-model="query" type="search" /></label>
    <p v-if="lease?.sessions.state.error" role="alert">{{ t('Live state is unavailable. Retry.') }} <button class="btn btn-sm" @click="lease?.sessions.refresh()">{{ t('Retry') }}</button></p>
    <p v-else-if="lease?.sessions.state.loading && !histories.length" role="status">{{ t('Loading') }}</p>
    <p v-else-if="!filtered.length" class="empty">{{ t('No posts or threads found.') }}</p>
    <ul><li v-for="post in filtered" :key="post.conversationId" class="post">
      <button v-if="post.histories.length === 1" class="post-open" @click="emit('open', post.histories[0]!.sessionId)"><strong>{{ post.title }}</strong><time v-if="post.lastActivityAt" :datetime="post.lastActivityAt">{{ formatDateTime(post.lastActivityAt) }}</time></button>
      <template v-else><div class="post-heading"><strong>{{ post.title }}</strong><time v-if="post.lastActivityAt" :datetime="post.lastActivityAt">{{ formatDateTime(post.lastActivityAt) }}</time></div>
        <div class="history-choices"><button v-for="history in post.histories" :key="history.sessionId" class="history-choice" @click="emit('open', history.sessionId)">{{ history.sessionId.startsWith('channel-inbox:') ? t('Passive inbox') : t('Original history') }}</button></div>
      </template>
    </li></ul>
  </section>
</template>
<script setup lang="ts">
import { computed, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from 'vue'
import { t, formatDateTime } from '../i18n.ts'
import { discordChannelHistories, discordChannelPosts, type DiscordChannelKey } from '../discord-navigation.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
const props = defineProps<{ apiBase: string; projectId: string; channelKey: DiscordChannelKey; active: boolean }>()
const emit = defineEmits<{ open: [id: string] }>()
const live = useProjectLiveState(), lease = shallowRef<ProjectLiveLease>()
const lifecycleActive = ref(true), query = ref('')
function release() { lease.value?.release(); lease.value = undefined }
watch(() => [props.apiBase, props.projectId, props.active, lifecycleActive.value] as const, () => {
  release()
  if (props.active && lifecycleActive.value && props.projectId) { lease.value = live.acquireProject(props.apiBase, props.projectId); void lease.value.sessions.read() }
}, { immediate: true })
watch(() => props.channelKey, () => { query.value = '' })
onActivated(() => { lifecycleActive.value = true })
onDeactivated(() => { lifecycleActive.value = false })
onUnmounted(release)
const histories = computed(() => props.channelKey.projectId === props.projectId ? discordChannelHistories(lease.value?.sessions.state.value ?? [], props.channelKey) : [])
const channelName = computed(() => histories.value.find(s => s.discordChannel?.id === props.channelKey.channelId)?.discordChannel?.name || histories.value.find(s => s.discordChannel?.parentName)?.discordChannel?.parentName || props.channelKey.channelId)
const filtered = computed(() => discordChannelPosts(histories.value, props.channelKey).filter(post => post.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
</script>
<style scoped>
.channel-index { max-width: 860px; margin: 0 auto; padding: 24px; color: var(--c-text); }
h2 { font-size: 20px; margin: 0 0 8px; overflow-wrap: anywhere; }
header p, .empty, time { color: var(--c-text-secondary); }
.channel-search { display: grid; gap: 8px; margin: 24px 0; font-size: 13px; }
input { width: 100%; box-sizing: border-box; padding: 8px; background: var(--c-bg-input); color: var(--c-text); border: 1px solid var(--c-border); border-radius: var(--radius-control); }
ul { margin: 0; padding: 0; list-style: none; }
li { border-top: 1px solid var(--c-border-soft); }
.post { padding: 16px 8px; overflow-wrap: anywhere; }
.post-heading, .post-open { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.post-open { width: 100%; padding: 0; border: 0; background: transparent; color: var(--c-text); font: inherit; text-align: start; cursor: pointer; }
.post-open:hover strong { text-decoration: underline; }
time { font-size: 12px; flex-shrink: 0; }
.history-choices { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.history-choice { font: inherit; font-size: 12px; padding: 6px 10px; border: 1px solid var(--c-border); background: transparent; color: var(--c-text); border-radius: var(--radius-control); cursor: pointer; }
.history-choice:hover { background: var(--c-bg-muted); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .channel-index { padding: 16px; } }
</style>
