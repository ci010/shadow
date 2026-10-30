<template>
  <App v-if="available && !roleActionActive" />
  <DesktopFrame v-else>
    <main class="workspace-recovery" aria-labelledby="workspace-title">
      <section class="workspace-recovery-panel">
        <header class="workspace-recovery-heading">
          <img :src="shadowLogo" alt="" aria-hidden="true" draggable="false">
          <h1 id="workspace-title">{{ t('Main workspace') }}</h1>
        </header>
        <p role="status">{{ available ? t('Connected to Main') : checking && !error ? t('Connecting to Main') : t('Main workspace unavailable. Retrying automatically; Child execution role is unchanged.') }}</p>
        <p>{{ t('Your setup is still saved.') }}</p>
        <code v-if="error" class="workspace-error">{{ error }}</code>
        <button class="btn workspace-retry" :disabled="checking" @click="connection.refresh">{{ checking ? t('Trying again…') : t('Retry') }}</button>
        <DesktopRoleSettings class="workspace-role-settings" @active="roleActionActive = $event" />
      </section>
    </main>
  </DesktopFrame>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import App from './App.vue'
import DesktopFrame from './DesktopFrame.vue'
import DesktopRoleSettings from './components/DesktopRoleSettings.vue'
import shadowLogo from './assets/shadow-logo.png'
import { t } from './i18n.ts'
import { useLiveClientPool } from './composables/useLiveClient.ts'
import { createChildWorkspaceConnection } from './child-workspace.ts'
const props = defineProps<{ apiBase: string }>()
const pool = useLiveClientPool()
const connection = createChildWorkspaceConnection(props.apiBase, { observeHost: pool.observeHost })
const { available, checking, error } = connection
const roleActionActive = ref(false)
onMounted(connection.refresh)
onBeforeUnmount(connection.dispose)
</script>
<style scoped>
.workspace-recovery { min-height: 100%; display: grid; place-items: center; padding: 32px 24px; background: var(--c-bg); color: var(--c-text); }
.workspace-recovery-panel { width: min(640px, 100%); min-width: 0; padding: 32px; border: 1px solid var(--c-border); background: var(--c-bg-card); overflow-wrap: anywhere; }
.workspace-recovery-heading { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.workspace-recovery-heading img { width: 40px; height: 40px; flex-shrink: 0; }
.workspace-recovery-heading h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.3; }
.workspace-recovery-panel > p { margin: 8px 0; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
.workspace-error { display: block; margin: 16px 0; padding: 12px; background: var(--c-bg-soft); color: var(--c-text-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.workspace-retry { margin-top: 16px; }
.workspace-recovery .workspace-role-settings { margin: 28px 0 0; padding: 24px 0 0; border: 0; border-top: 1px solid var(--c-border); border-radius: 0; }
@media (max-width: 480px) {
  .workspace-recovery { padding: 16px; place-items: start center; }
  .workspace-recovery-panel { padding: 20px; }
}
</style>
