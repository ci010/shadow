<template>
  <div class="settings-view">
    <header class="settings-heading"><h1>App settings</h1><p>Provider connections and web search settings are shared across Projects. Model defaults can be overridden by Projects and conversations.</p></header>
    <p v-if="!available" role="status">Settings are managed by Main administrators.</p>
    <div v-else class="settings-layout">
      <nav class="settings-navigation" aria-label="Settings sections">
        <RouterLink v-for="item in sections" :key="item.id" :to="{ name: 'settings', params: { section: item.id } }"
          :aria-current="section === item.id ? 'page' : undefined" :class="{ selected: section === item.id }">
          <span :class="item.icon" aria-hidden="true" />{{ item.label }}
        </RouterLink>
      </nav>
      <div class="settings-section">
        <ModelDefaultsForm v-if="section === 'models'" :api-base="apiBase" scope="app" />
        <WebSearchSettings v-if="section === 'web-search'" :api-base="apiBase" />
        <ProvidersView v-show="section === 'providers'" v-bind="props" embedded :active="section === 'providers'"
          @configured="$emit('configured')" @retry="$emit('retry')" @close="$emit('close')" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ProviderSetupStatus } from '../provider-setup.ts'
import ProvidersView from './ProvidersView.vue'
import ModelDefaultsForm from './ModelDefaultsForm.vue'
import WebSearchSettings from './WebSearchSettings.vue'

const props = defineProps<{ apiBase: string; status: ProviderSetupStatus | null; error: string; checking: boolean; available: boolean }>()
defineEmits<{ configured: []; retry: []; close: [] }>()
const route = useRoute()
const sections = [
  { id: 'providers', label: 'Providers', icon: 'i-lucide-cpu' },
  { id: 'models', label: 'Models', icon: 'i-lucide-sliders-horizontal' },
  { id: 'web-search', label: 'Web search', icon: 'i-lucide-search' },
]
const section = computed(() => sections.find(item => item.id === route.params.section)?.id ?? 'providers')
</script>

<style scoped>
.settings-view { width: 100%; max-width: 1240px; min-width: 0; margin: 0 auto; padding: 28px 24px 48px; color: var(--c-text); }
.settings-heading { margin-bottom: 28px; }
.settings-heading h1 { margin: 0 0 8px; font-size: 24px; }
.settings-heading p { margin: 0; color: var(--c-text-secondary); font-size: 14px; }
.settings-layout { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 32px; }
.settings-navigation { display: flex; flex-direction: column; gap: 4px; align-self: start; }
.settings-navigation a { display: flex; align-items: center; gap: 10px; padding: 12px; color: var(--c-text-secondary); text-decoration: none; font-size: 14px; }
.settings-navigation span { display: inline-block; width: 16px; height: 16px; }
.settings-navigation a:hover, .settings-navigation .selected { background: var(--c-bg-muted); color: var(--c-text); }
.settings-navigation .selected { font-weight: 600; }
.settings-navigation a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.settings-section { min-width: 0; }
@media (max-width: 700px) {
  .settings-view { padding: 20px 16px 32px; }
  .settings-heading { margin-bottom: 20px; }
  .settings-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .settings-navigation { flex-direction: row; flex-wrap: wrap; border-bottom: 1px solid var(--c-border); }
  .settings-navigation a { flex: 1 0 auto; min-height: 44px; }
}
</style>
