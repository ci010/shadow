<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <p class="eyebrow">This machine</p>
        <h1>Approvals</h1>
        <p class="page-summary">Requests that must be decided on the Child that owns the capability.</p>
      </div>
      <div class="context-strip" aria-label="Local approval status">
        <span class="role-mark">{{ context.mode === 'child' ? 'Child' : 'Main' }}</span>
        <span>{{ pendingApprovals.length }} pending locally</span>
      </div>
    </header>

    <div v-if="pendingApprovals.length" class="approval-list">
      <article v-for="approval in pendingApprovals" :key="approval.requestId" class="approval-row">
        <header class="approval-header">
          <div class="min-w-0">
            <div class="approval-title-line">
              <span class="operation-mark">{{ operationLabel(approval.operation.kind) }}</span>
              <h2>{{ approval.operation.summary }}</h2>
            </div>
            <p class="requester-line">
              <strong>{{ approval.requester.agentName }}</strong>
              <span>{{ approval.requester.sessionLabel }}</span>
              <span class="mono break-value">{{ approval.requester.sessionId }}</span>
            </p>
          </div>
          <span class="expiry-mark">Expires in {{ approval.expiresIn }}</span>
        </header>

        <dl class="approval-details">
          <div v-for="detail in approval.operation.details" :key="detail.label">
            <dt>{{ detail.label }}</dt>
            <dd class="mono break-value">{{ detail.value }}</dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd class="mono break-value">{{ approval.scope.nodeId }}</dd>
          </div>
          <div>
            <dt>Workdir scope</dt>
            <dd class="mono break-value">{{ approval.scope.displayPath }}</dd>
          </div>
        </dl>

        <footer class="approval-actions" aria-label="Fixture-safe approval decisions">
          <p>Decision controls remain unavailable until the local approval service is connected.</p>
          <div>
            <button type="button" disabled>Allow once</button>
            <button type="button" disabled>Allow for session</button>
            <button type="button" disabled class="deny-button">Deny</button>
          </div>
        </footer>
      </article>
    </div>

    <div v-else class="empty-panel">
      <h2>No pending local approvals</h2>
      <p>Requests owned by another node must be reviewed on that machine.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { useProductFixtures } from '../composables/useProductFixtures.ts'
import type { ApprovalRequestFixture } from '../product-fixtures.ts'

const context = useInstallationContext()
const fixtures = useProductFixtures()

const pendingApprovals = computed(() => fixtures.value.approvals.filter((approval) =>
  approval.ownerNodeId === context.value.localNodeId && approval.status === 'pending'
))

function operationLabel(kind: ApprovalRequestFixture['operation']['kind']): string {
  return kind === 'shell' ? 'Shell' : 'Files'
}
</script>

<style scoped src="../product-views.css"></style>