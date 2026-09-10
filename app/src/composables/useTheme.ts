import { ref, watchEffect } from 'vue'

const mq = window.matchMedia('(prefers-color-scheme: dark)')

function getStored(): 'dark' | 'light' | null {
  const v = localStorage.getItem('theme')
  return v === 'dark' || v === 'light' ? v : null
}

function applyClass(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

const stored = getStored()
const isDark = ref(stored ? stored === 'dark' : mq.matches)

// Apply immediately
applyClass(isDark.value)

// Sync class whenever ref changes
watchEffect(() => applyClass(isDark.value))

// Listen for OS theme change — only apply if user hasn't overridden
mq.addEventListener('change', (e) => {
  if (!getStored()) {
    isDark.value = e.matches
  }
})

export function useTheme() {
  function toggleTheme() {
    isDark.value = !isDark.value
    localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  }

  return { isDark, toggleTheme }
}
