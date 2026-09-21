<template>
  <article class="pending-device" :aria-label="`Verify ${device.displayName}`">
    <h3>{{ device.displayName }}</h3>
    <p>Requested {{ new Date(device.requestedAt).toLocaleString() }} · Node <code>{{ device.nodeId }}</code></p>
    <p>Compare this entire fingerprint with the one shown on the Child machine. A matching name or PIN is not enough.</p>
    <dl><dt>Device identity fingerprint</dt><dd class="fingerprint">{{ device.deviceIdentityFingerprint }}</dd></dl>
    <label class="consent">
      <input v-model="verified" type="checkbox" :disabled="disabled" />
      <span>I checked the fingerprint on the Child and it matches exactly.</span>
    </label>
    <label class="consent">
      <input v-model="consented" type="checkbox" :disabled="disabled" />
      <span>I trust this device and authorize Main to run tasks and access workdirs through the capabilities configured on this Child. Commands run with the Child’s OS-account permissions; a workdir is not a sandbox.</span>
    </label>
    <p v-if="!device.credentialId" class="device-error">This request has no credential identity. Pair again from an updated Child.</p>
    <button type="button" class="device-button primary" :disabled="disabled || !verified || !consented || !device.credentialId" @click="approve">
      {{ busy ? 'Approving…' : 'Approve device' }}
    </button>
  </article>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { deviceApprovalBody, type PendingDevice } from './device-administration.ts'

const props = defineProps<{ device: PendingDevice; disabled: boolean; busy: boolean }>()
const emit = defineEmits<{ approve: [device: PendingDevice, body: ReturnType<typeof deviceApprovalBody>] }>()
const verified = ref(false)
const consented = ref(false)
function approve() {
  if (props.disabled || !verified.value || !consented.value || !props.device.credentialId) return
  emit('approve', props.device, deviceApprovalBody(props.device, verified.value, consented.value))
  verified.value = false
  consented.value = false
}
</script>

<style scoped src="./device-administration.css"></style>
