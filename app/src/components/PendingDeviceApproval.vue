<template>
  <article class="pending-device" :aria-label="t('Verify {displayName}', { displayName: device.displayName })">
    <h3>{{ device.displayName }}</h3>
    <p>{{ t('Requested') }} {{ formatDateTime(new Date(device.requestedAt)) }} {{ t('· Node') }} <code>{{ device.nodeId }}</code></p>
    <p>{{ t('Compare this entire fingerprint with the one shown on the Child machine. A matching name or PIN is not enough.') }}</p>
    <dl><dt>{{ t('Device identity fingerprint') }}</dt><dd class="fingerprint">{{ device.deviceIdentityFingerprint }}</dd></dl>
    <label class="consent">
      <input v-model="verified" type="checkbox" :disabled="disabled" />
      <span>{{ t('I checked the fingerprint on the Child and it matches exactly.') }}</span>
    </label>
    <label class="consent">
      <input v-model="consented" type="checkbox" :disabled="disabled" />
      <span>{{ t('I trust this device and authorize Main to run tasks and access workdirs through the capabilities configured on this Child. Commands run with the Child’s OS-account permissions; a workdir is not a sandbox.') }}</span>
    </label>
    <p v-if="!device.credentialId" class="device-error">{{ t('This request has no credential identity. Pair again from an updated Child.') }}</p>
    <button type="button" class="device-button primary" :disabled="disabled || !verified || !consented || !device.credentialId" @click="approve">
      {{ busy ? t('Approving…') : t('Approve device') }}
    </button>
  </article>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
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
