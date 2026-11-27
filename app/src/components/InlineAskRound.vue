<template>
  <div class="ask-round">
    <article v-for="(question, index) in round.questions" :key="index" class="ask-card"
      :data-request-id="round.requestId" :data-ask-index="index" :aria-label="questionLabel(index)">
      <header v-if="multiple" class="ask-caption">{{ questionLabel(index) }}</header>
      <MarkdownContent class="prose selectable-text" :text="question.content" :render-content="renderContent" />
      <template v-if="editable">
        <div class="ask-options" role="group" :aria-label="questionLabel(index)">
          <button v-for="option in question.options" :key="option" type="button" class="btn btn-sm ask-option" :disabled="busy"
            :aria-pressed="multiple ? optionSelected(index, option) : undefined" @click="emit('choose', index, option)">{{ option }}</button>
          <button type="button" class="btn btn-sm btn-ghost ask-option" :disabled="busy" :aria-controls="composerId"
            :aria-pressed="target === index" @click="emit('custom', index)">{{ t('Or type your own answer...') }}</button>
        </div>
        <p v-if="drafts[index] && 'text' in drafts[index]!" class="ask-answer selectable-text">
          <strong>{{ t('Your answer') }}</strong> {{ drafts[index]!.text }}
        </p>
        <p v-if="drafts[index] && 'text' in drafts[index]! && drafts[index]!.media?.length" class="ask-caption">
          {{ t('{count} attached file(s)', { count: drafts[index]!.media!.length }) }}
        </p>
        <p v-if="deadline && index === round.questions.length - 1" class="ask-caption">{{ deadline }}</p>
        <div v-if="index === round.questions.length - 1 && (multiple || error)" class="ask-submit">
          <p v-if="error" class="ask-error" role="alert">{{ error }}</p>
          <button v-if="error" class="btn btn-sm" type="button" :disabled="busy || loading" @click="emit('refresh')">{{ t('Reload question') }}</button>
          <span v-if="multiple" class="ask-caption" role="status">{{ t('{answered} of {total} answers ready', { answered: answeredCount, total: round.questions.length }) }}</span>
          <button v-if="multiple" class="btn btn-sm btn-primary" type="button" data-inline-ask-submit :disabled="busy || answeredCount !== round.questions.length"
            @click="emit('submit')">{{ busy ? t('Submitting…') : t('Submit answers') }}</button>
        </div>
      </template>
      <section v-else-if="round.receipt?.answers[index]" class="ask-answer selectable-text" :aria-label="t('Recorded response')">
        <strong>{{ t('Recorded response') }}</strong>
        <p>{{ answerText(round.receipt.answers[index]!) }}</p>
        <MessageAttachments v-if="answerMedia(round.receipt.answers[index]!).length" :paths="answerMedia(round.receipt.answers[index]!)"
          :api-base="apiBase" :session-id="sessionId" :workdir="workdir" @preview="emit('preview', $event)" @open="emit('open', $event)" />
      </section>
      <p v-else class="ask-caption">{{ inputStatusLabel(round.status) }}</p>
      <div class="ask-footer"><MessageTimestamp :timestamp="round.timestamp" /></div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import { inputStatusLabel } from '../input-history.ts'
import type { InlineAskRound } from '../inline-ask-history.ts'
import type { InlineAskAnswer } from '../inline-ask.ts'
import type { SessionDetails } from '../session-details.ts'
import type { ImagePreview } from '../image-viewer.ts'
import type { OpenFile } from '../file-workbench.ts'
import MarkdownContent from './MarkdownContent.vue'
import MessageAttachments from './MessageAttachments.vue'
import MessageTimestamp from './MessageTimestamp.vue'

const props = defineProps<{
  round: InlineAskRound; drafts: readonly (InlineAskAnswer | undefined)[]; editable: boolean; busy: boolean;
  target: number; composerId: string; deadline?: string; error?: string; loading?: boolean; renderContent: (source: string) => string;
  apiBase: string; sessionId: string; workdir?: SessionDetails['workdir'];
}>()
const emit = defineEmits<{ choose: [index: number, option: string]; custom: [index: number]; submit: []; refresh: []; preview: [image: ImagePreview]; open: [file: OpenFile] }>()
const multiple = computed(() => props.round.questions.length > 1)
const answeredCount = computed(() => props.drafts.filter(Boolean).length)
const questionLabel = (index: number) => multiple.value
  ? t('Question {number} of {total}', { number: index + 1, total: props.round.questions.length }) : t('Question')
function optionSelected(index: number, option: string) {
  const draft = props.drafts[index]
  return draft && 'option' in draft ? draft.option === option : false
}
function answerText(answer: InlineAskAnswer) { return 'option' in answer ? answer.option : answer.text }
function answerMedia(answer: InlineAskAnswer) { return 'text' in answer ? answer.media ?? [] : [] }
</script>

<style scoped>
.ask-round { display: grid; gap: .5rem; width: fit-content; max-width: var(--conversation-item-max-width, 80%); min-width: 0; }
.ask-card { color: var(--c-text); font-size: .8rem; line-height: 1.5; background: var(--c-chat-assistant-bg); border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); padding: .5rem .75rem; min-width: 0; overflow-wrap: anywhere; }
.ask-caption { color: var(--c-text-secondary); font-size: 12px; margin-block: 0 .4rem; }
.ask-options, .ask-submit { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin-block: .6rem .25rem; }
.ask-option { max-width: 100%; text-align: start; white-space: normal; }
.ask-option[aria-pressed='true'] { background: var(--c-selection-bg); border-color: var(--c-selection-border); color: var(--c-primary); }
.ask-submit > span { margin-inline-end: auto; margin-block: 0; }
.ask-error { flex-basis: 100%; color: var(--c-error); margin: 0; }
.ask-answer { border-block-start: 1px solid var(--c-chat-border); margin-block: .6rem 0; padding-block-start: .45rem; white-space: pre-wrap; }
.ask-answer p { margin-block: .25rem; }
.ask-footer { margin-block-start: .3rem; }
</style>
