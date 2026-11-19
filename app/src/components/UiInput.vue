<template>
  <input v-model="fieldValue" class="ui-field ui-input" :type="type" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

// Keep the native element as the root so labels, validation, form submission,
// autocomplete and DOM events work without a synthetic input contract.
const props = withDefaults(defineProps<{
  type?: 'text' | 'search' | 'email' | 'password' | 'tel' | 'url'
  value?: string
  modelValue?: string
}>(), { type: 'text' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const localValue = ref('')
const fieldValue = computed({
  get: () => props.modelValue ?? props.value ?? localValue.value,
  set: (value: string) => {
    localValue.value = value
    emit('update:modelValue', value)
  },
})
</script>
