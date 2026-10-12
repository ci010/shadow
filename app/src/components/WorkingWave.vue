<template>
  <span class="working-wave" aria-hidden="true"><i /><i /><i /></span>
</template>

<style scoped>
.working-wave { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; width: 26px; height: 16px; }
.working-wave i { width: 6px; height: 6px; background: currentColor; animation: working-wave 1.2s ease-in-out infinite; }
.working-wave i:nth-child(2) { animation-delay: .15s; }
.working-wave i:nth-child(3) { animation-delay: .3s; }
@keyframes working-wave { 0%, 100% { transform: scale(.35); opacity: .45; } 50% { transform: scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .working-wave i { animation: none; } }
</style>
