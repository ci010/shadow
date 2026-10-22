<template>
  <App v-if="available && !local" @child-status="local = true" />
  <template v-else>
    <div class="child-workspace-actions">
      <span>{{ t('Child') }}</span>
      <button class="btn" :disabled="!available" @click="local = false">{{ t('Open Main workspace') }}</button>
    </div>
    <p class="workspace-state" role="status">{{ checking ? t('Connecting to Main') : t('Main workspace is offline or approval is pending. Retrying automatically; Child execution role is unchanged.') }}</p>
    <ChildDesktop :api-base="apiBase" />
  </template>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import App from './App.vue'
import ChildDesktop from './ChildDesktop.vue'
import { t } from './i18n.ts'
import { createChildWorkspaceConnection } from './child-workspace.ts'
const props = defineProps<{ apiBase: string }>()
const local = ref(false)
const connection = createChildWorkspaceConnection(props.apiBase)
const { available, checking } = connection
onMounted(connection.refresh)
onBeforeUnmount(connection.dispose)
</script>
<style scoped>
.child-workspace-actions { display: flex; align-items: center; gap: 8px; background: var(--c-bg-card); padding: 8px 24px; border-bottom: 1px solid var(--c-border); }
.workspace-state { margin: 0; padding: 12px 24px; color: var(--c-text-secondary); }
</style>
