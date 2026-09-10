<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <p class="eyebrow">Execution locality</p>
        <h1>Workspaces</h1>
        <p class="page-summary">Workdir capabilities are grouped by the node that owns and enforces them.</p>
      </div>
      <div class="context-strip" aria-label="Installation status">
        <span class="role-mark">{{ context.mode === 'main' ? 'Main' : 'Child' }}</span>
        <span class="status-dot" :class="context.mainConnection" />
        <span>{{ connectionLabel(context.mainConnection) }}</span>
      </div>
    </header>

    <div class="node-list">
      <article v-for="node in fixtures.nodes" :key="node.nodeId" class="node-section">
        <header class="node-header">
          <div class="node-identity">
            <span class="status-dot" :class="node.connection" />
            <div class="min-w-0">
              <h2>{{ node.displayName }}</h2>
              <p class="mono break-value">{{ node.nodeId }}</p>
            </div>
          </div>
          <div class="node-marks">
            <span class="role-mark">{{ node.role === 'main' ? 'Main' : 'Child' }}</span>
            <span class="connection-label">{{ connectionLabel(node.connection) }}</span>
          </div>
        </header>

        <div class="capability-grid">
          <article v-for="capability in node.capabilities" :key="capability.capabilityId" class="capability-card">
            <div class="capability-top">
              <div class="min-w-0">
                <h3>{{ capability.displayName }}</h3>
                <p class="path mono">{{ capability.displayPath }}</p>
              </div>
              <span class="availability" :class="capability.availability">
                {{ availabilityLabel(capability.availability) }}
              </span>
            </div>
            <p v-if="capability.unavailableReason" class="unavailable-reason">{{ capability.unavailableReason }}</p>
            <dl class="capability-meta">
              <div>
                <dt>Permissions</dt>
                <dd class="permission-list">
                  <span v-for="permission in capability.permissions" :key="permission">{{ permission }}</span>
                </dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>{{ approvalLabel(capability.approvalPolicy) }}</dd>
              </div>
              <div>
                <dt>Capability</dt>
                <dd class="mono break-value">{{ capability.capabilityId }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { useProductFixtures } from '../composables/useProductFixtures.ts'
import type {
  CapabilityAvailability,
  NodeConnection,
  WorkdirCapabilityFixture,
} from '../product-fixtures.ts'

const context = useInstallationContext()
const fixtures = useProductFixtures()

function connectionLabel(connection: NodeConnection | typeof context.value.mainConnection): string {
  if (connection === 'unpaired') return 'Main unpaired'
  if (connection === 'offline') return 'Offline'
  if (connection === 'connecting') return 'Connecting'
  return 'Connected'
}

function availabilityLabel(availability: CapabilityAvailability): string {
  if (availability === 'online') return 'Online'
  if (availability === 'revoked') return 'Revoked'
  return 'Unavailable'
}

function approvalLabel(policy: WorkdirCapabilityFixture['approvalPolicy']): string {
  if (policy === 'always') return 'Every operation'
  if (policy === 'session') return 'Per session'
  return 'Capability grant'
}
</script>

<style scoped src="../product-views.css"></style>