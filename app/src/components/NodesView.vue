<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <p class="eyebrow">Execution fleet</p>
        <h1>Nodes</h1>
        <p class="page-summary">Connection and capability state as reported by the fixture-backed registry.</p>
      </div>
      <div class="context-strip" aria-label="Administration access">
        <span class="role-mark">{{ context.mode === 'main' ? 'Main' : 'Child' }}</span>
        <span>{{ canAdminister ? 'Node admin scope' : 'Read only' }}</span>
      </div>
    </header>

    <div class="node-admin-list">
      <article v-for="node in fixtures.nodes" :key="node.nodeId" class="node-admin-row">
        <div class="node-admin-primary">
          <span class="status-dot large" :class="node.connection" />
          <div class="min-w-0">
            <div class="node-title-line">
              <h2>{{ node.displayName }}</h2>
              <span class="role-mark">{{ node.role === 'main' ? 'Main' : 'Child' }}</span>
              <span v-if="node.isLocal" class="local-mark">This machine</span>
            </div>
            <p class="mono break-value">{{ node.nodeId }}</p>
          </div>
        </div>

        <dl class="node-facts">
          <div><dt>Connection</dt><dd>{{ connectionLabel(node.connection) }}</dd></div>
          <div><dt>Version</dt><dd class="mono">{{ node.version }}</dd></div>
          <div><dt>Last seen</dt><dd>{{ node.lastSeen }}</dd></div>
          <div><dt>Workdirs</dt><dd>{{ node.capabilities.length }}</dd></div>
        </dl>

        <div class="capability-summary">
          <span
            v-for="capability in node.capabilities"
            :key="capability.capabilityId"
            class="summary-chip"
            :class="capability.availability"
            :title="capability.displayPath"
          >
            {{ capability.displayName }} · {{ capability.permissions.join(', ') }}
          </span>
        </div>

        <div v-if="canManageNode(node.nodeId)" class="admin-actions" aria-label="Fixture-safe node administration">
          <button type="button" disabled title="Available after the live node registry is connected">Review grants</button>
          <button type="button" disabled title="Available after the live node registry is connected">Revoke node</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { useProductFixtures } from '../composables/useProductFixtures.ts'
import type { NodeConnection } from '../product-fixtures.ts'

const context = useInstallationContext()
const fixtures = useProductFixtures()
const canAdminister = computed(() => context.value.uiScopes.includes('nodes:admin'))

function canManageNode(nodeId: string): boolean {
  return canAdminister.value ||
    (context.value.mode === 'child' && nodeId === context.value.localNodeId)
}

function connectionLabel(connection: NodeConnection): string {
  if (connection === 'offline') return 'Offline'
  if (connection === 'connecting') return 'Connecting to Main'
  return 'Connected'
}
</script>

<style scoped src="../product-views.css"></style>