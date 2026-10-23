<template>
  <App v-if="available" />
  <main v-else class="workspace-recovery" aria-labelledby="workspace-title">
    <h1 id="workspace-title">{{ t('Main workspace') }}</h1>
    <p role="status">{{ checking ? t('Connecting to Main') : t('Main workspace unavailable. Retrying automatically; Child execution role is unchanged.') }}</p>
    <code v-if="error">{{ error }}</code>
    <button class="btn" :disabled="checking" @click="connection.refresh">{{ t('Retry') }}</button>
  </main>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import App from './App.vue'
import { t } from './i18n.ts'
import { createChildWorkspaceConnection } from './child-workspace.ts'
const props = defineProps<{ apiBase: string }>()
const connection = createChildWorkspaceConnection(props.apiBase)
const { available, checking, error } = connection
onMounted(connection.refresh)
onBeforeUnmount(connection.dispose)
</script>
<style scoped>
.workspace-recovery { max-width: 560px; margin: 15vh auto; padding: 24px; color: var(--c-text-secondary); }
.workspace-recovery code { display: block; margin-bottom: 16px; overflow-wrap: anywhere; }
</style>
