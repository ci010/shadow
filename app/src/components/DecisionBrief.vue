<template>
  <section class="decision-brief selectable-text" :class="{ 'basis-graph': graph }" :aria-label="t('Decision brief and basis')">
    <div class="basis-node"><strong>{{ t('Original goal') }}</strong><p>{{ brief.goal }}</p></div>
    <details class="basis-evidence" :open="graph">
      <summary>{{ t('Evidence, assumptions and proposals') }}</summary>
      <article v-for="(claim, index) in brief.claims" :key="index" class="basis-node" :class="claim.kind">
        <strong>{{ labels[claim.kind] }}</strong><p>{{ claim.text }}</p>
        <details v-if="claim.evidence" class="evidence-source">
          <summary>{{ t('Exact') }} {{ claim.evidence.kind === 'user' ? t('human input') : t('tool receipt') }} {{ t('excerpt') }}</summary>
          <blockquote>{{ claim.evidence.quote }}</blockquote>
          <p>{{ t('Session:') }} {{ claim.evidence.sessionId }} {{ t('· Segment:') }} {{ claim.evidence.physicalId }} {{ t('· Source:') }} {{ claim.evidence.id }}</p>
          <p>{{ t('Authorship and excerpt are checked against the saved record; the agent\'s interpretation is not independently verified.') }}</p>
          <button type="button" @click="emit('inspect', claim.evidence.sessionId)">{{ t('Open evidence session') }}</button>
        </details>
      </article>
    </details>
    <div class="basis-node"><strong>{{ t('Why your decision is needed') }}</strong><p>{{ brief.whyHuman }}</p></div>
    <div class="basis-node"><strong>{{ t('Agent recommendation') }}</strong><p>{{ brief.recommendation }}</p><strong>{{ t('Tradeoff') }}</strong><p>{{ brief.tradeoff }}</p></div>
    <div class="basis-scope">
      <div class="basis-node"><strong>{{ t('Blocked until decided') }}</strong><ul><li v-for="work in brief.blocked" :key="work">{{ work }}</li></ul></div>
      <div class="basis-node"><strong>{{ t('Can continue within existing authorization') }}</strong>
        <ul v-if="brief.unaffected.length"><li v-for="work in brief.unaffected" :key="work">{{ work }}</li></ul><p v-else>{{ t('No independent work identified.') }}</p>
      </div>
    </div>
    <p v-if="graph" class="basis-note">{{ t('Flow expresses the agent\'s stated rationale, not proven causation. Dashed nodes are assumptions or proposals.') }}</p>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import type { DecisionBrief } from '../../../src/sessions/decision-brief.ts'
defineProps<{ brief: DecisionBrief; graph?: boolean }>()
const emit = defineEmits<{ inspect: [sessionId: string] }>()
const labels = { get user_constraint() { return t('Recorded user constraint') }, get observation() { return t('Agent observation with a source') },
  get assumption() { return t('Unverified assumption') }, get proposal() { return t('Agent proposal, not a user requirement') } }
</script>

<style scoped>
.decision-brief { min-width: 0; font-size: 12px; margin: 8px 0; }
.basis-node { min-width: 0; margin: 8px 0; padding: 8px 10px; border-left: 2px solid var(--c-border); background: var(--c-bg-soft); overflow-wrap: anywhere; }
.user_constraint { border-color: var(--c-blue); }
.assumption, .proposal { border: 1px dashed var(--c-border); }
p { margin: 4px 0; white-space: pre-wrap; }
summary { cursor: pointer; }
blockquote { margin: 8px 0; padding-left: 8px; border-left: 2px solid var(--c-blue); white-space: pre-wrap; }
ul { padding-left: 18px; list-style: disc; }
.basis-scope { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.basis-graph > .basis-node, .basis-graph > .basis-evidence { position: relative; margin-bottom: 22px; border: 1px solid var(--c-border); padding: 10px; }
.basis-graph > .basis-node::after, .basis-graph > .basis-evidence::after { content: ''; position: absolute; bottom: -20px; left: 50%; height: 18px; border-left: 1px dashed var(--c-text-muted); }
.basis-note { color: var(--c-text-secondary); }
button { min-height: 36px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-card); cursor: pointer; }
@media (max-width: 600px) { .basis-scope { grid-template-columns: 1fr; } button { min-height: 44px; } }
</style>
