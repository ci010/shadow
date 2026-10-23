<template>
  <div class="language-selector">
    <span class="i-lucide-languages" aria-hidden="true" />
    <UiSelect :aria-label="t('Language')" :title="t('Language')" :value="localePreference" @change="changeLanguage">
      <option value="system">{{ t('System language') }}</option>
      <option value="en" lang="en">English</option>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
    </UiSelect>
    <span v-if="localePersistenceError" class="language-error" role="alert">{{ t('Language preference could not be saved. It will apply until you close this window.') }}</span>
  </div>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { isLocalePreference, localePersistenceError, localePreference, setLocalePreference, t } from '../i18n.ts'

function changeLanguage(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (isLocalePreference(value)) setLocalePreference(value)
}
</script>

<style scoped>
.language-selector { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; max-width: 100%; color: var(--c-text); -webkit-app-region: no-drag; }
.language-selector > span:first-child { flex-shrink: 0; width: 16px; height: 16px; }
.ui-select { min-width: 0; max-width: 100%; min-height: 32px; padding: 4px 6px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.ui-select:is(:focus-visible, :has(:focus-visible)) { outline: 2px solid var(--c-primary); outline-offset: 2px; }
.language-error { max-width: 30ch; color: var(--c-error); font-size: 12px; line-height: 1.5; }
@media (max-width: 700px), (pointer: coarse) { .ui-select { min-height: 44px; font-size: 16px; } }
</style>
