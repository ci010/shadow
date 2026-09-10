<template>
  <div class="providers-view">
    <p v-if="!available" role="status">Provider settings are managed by Main administrators.</p>
    <p v-else-if="checking" role="status">Checking model provider configuration...</p>
    <template v-else>
      <ProviderSetup
        :key="apiBase + (status?.provider ?? '')"
        :api-base="apiBase"
        :status="status"
        :error="error"
        @configured="$emit('configured')"
        @retry="$emit('retry')"
        @close="$emit('close')"
      />
      <ModelSelector v-if="status?.ready" class="settings-model-selector" />
    </template>
  </div>
</template>

<script setup lang="ts">
import ProviderSetup from '../ProviderSetup.vue'
import ModelSelector from './ModelSelector.vue'
import type { ProviderSetupStatus } from '../provider-setup.ts'

defineProps<{
  apiBase: string
  status: ProviderSetupStatus | null
  error: string
  checking: boolean
  available: boolean
}>()
defineEmits<{ configured: []; retry: []; close: [] }>()
</script>

<style scoped>
.providers-view { min-width: 0; }
.settings-model-selector { max-width: 680px; margin: 16px auto; }
</style>
