<template>
  <div
    class="chat-workspace"
    :class="{ 'mobile-sessions-open': mobileSidebarOpen, 'is-draft': !activeSessionId }"
  >
    <button class="mobile-sessions-toggle btn btn-sm" :aria-expanded="mobileSidebarOpen" aria-controls="sessions-sidebar" @click="mobileSidebarOpen = !mobileSidebarOpen">Projects</button>
    <button v-if="mobileSidebarOpen" class="mobile-sidebar-backdrop" aria-label="Close projects" @click="mobileSidebarOpen = false" />
    <ProjectsSidebar
      :api-base="apiBase"
      :sessions="allSessions"
      :active-session-id="activeSessionId"
      :draft-project-id="draft.project?.id"
      :collapsed="collapsedSessions"
      :stages="displayedSessionStages"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
      @select="selectSession($event); mobileSidebarOpen = false"
      @delete="deleteSession"
      @toggle="toggleCollapse"
      @reload="loadSessionList"
      @scratch="createNewWebChat"
      @draft="createNewWebChat"
    />

    <!-- Chat area -->
    <div class="chat-panel" :class="{ 'is-draft': !activeSessionId }">
      <div v-if="!activeSessionId" class="draft-heading">
        <div v-if="!draft.project" class="draft-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M24 5 40 14v20L24 43 8 34V14L24 5Z" /><path d="m24 14 9 5v10l-9 5-9-5V19l9-5Z" /></svg>
        </div>
        <h1>What would you like to work on?</h1>
        <div v-if="draft.project" class="draft-project" :aria-label="`Working folder: ${draft.project.name}`">
          <svg class="draft-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h6l3 3h9v11H3V6Z" /><path d="M3 6V4h6l3 3h9v2" /></svg>
          <div class="draft-project-copy">
            <span class="draft-project-label">New conversation in project folder</span>
            <strong>{{ draft.project.name }}</strong>
            <span class="draft-project-path" :title="draft.project.path">{{ draft.project.path }}</span>
          </div>
        </div>
        <p v-else class="draft-scratch">From scratch &middot; No project folder</p>
      </div>
      <template v-else>
        <!-- Header -->
        <div class="chat-header px-4 py-3 border-b border-default flex items-center justify-between" style="background: var(--c-frosted); backdrop-filter: blur(4px)">
          <div class="chat-heading-copy">
            <div class="text-xs text-ink/50 font-600 uppercase tracking-widest">{{ isDirectChat ? 'Direct Chat' : 'Session (readonly)' }}</div>
            <div class="chat-session-meta text-sm font-mono text-ink/70">
              <span>{{ activeSessionId }}</span>
              <SessionActivity :stage="sessionStage" :title="stageError || undefined" />
            </div>
            <div class="session-config-badges">
              <span v-if="activeSessionConfig.model" class="config-badge model">{{ activeSessionConfig.model }}</span>
              <span class="config-badge" :class="activeSessionConfig.thinking?.type === 'enabled' ? 'thinking-on' : 'thinking-off'">thinking: {{ activeSessionConfig.thinking?.type ?? 'default' }}</span>
              <span class="config-badge effort">effort: {{ activeSessionConfig.reasoningEffort ?? 'default' }}</span>
            </div>
          </div>
          <button class="btn btn-sm" @click="loadCurrentSession">Refresh</button>
        </div>

        <div class="conversation-tabs" role="tablist" aria-label="Session view">
          <button id="conversation-tab" role="tab" aria-controls="conversation-panel" :aria-selected="activePanel === 'conversation'" :tabindex="activePanel === 'conversation' ? 0 : -1" :class="{ active: activePanel === 'conversation' }" @click="switchPanel('conversation')" @keydown="handlePanelKey($event, 'conversation')">Conversation</button>
          <button id="diagnosis-tab" role="tab" aria-controls="diagnosis-panel" :aria-selected="activePanel === 'diagnosis'" :tabindex="activePanel === 'diagnosis' ? 0 : -1" :class="{ active: activePanel === 'diagnosis' }" @click="switchPanel('diagnosis')" @keydown="handlePanelKey($event, 'diagnosis')">
            <span class="i-lucide-activity w-4 h-4" aria-hidden="true" />Diagnosis
          </button>
        </div>
        <SessionDiagnosis v-if="diagnosisOpened" v-show="activePanel === 'diagnosis'" id="diagnosis-panel" role="tabpanel" aria-labelledby="diagnosis-tab"
          :api-base="apiBase" :session-id="activeSessionId" :physical-id="viewingPhysicalId"
          :active="activePanel === 'diagnosis' && route.name === 'chat'" :can-read-trace="installation.uiScopes.includes('audit:read')"
          :working="sessionWorking" :system-prompt="systemPrompt" :compaction-summary="compactionSummary" :tools="tools" />

        <!-- Messages -->
        <div v-show="activePanel === 'conversation'" id="conversation-panel" class="chat-history" role="tabpanel" aria-labelledby="conversation-tab">
        <div ref="messagesContainer" class="flex-1 overflow-y-auto px-4 py-3 chat-messages" style="position: relative;" @click="handleChatAreaClick">
          <!-- SVG filter for hand-drawn highlight edges -->
          <svg width="0" height="0" style="position: absolute;">
            <filter id="highlight-rough">
              <feTurbulence type="turbulence" baseFrequency="0.05 0.08" numOctaves="3" seed="2" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </svg>
          <!-- Selection highlight overlay -->
          <div
            v-for="(r, i) in highlightRects"
            :key="'hl-' + i"
            class="selection-highlight-overlay"
            :style="{ top: r.top + 'px', left: (r.left - 2) + 'px', width: (r.width + 4) + 'px', height: (r.height + 2) + 'px' }"
          />
          <div v-if="loadingHistory" class="text-sm text-ink/50">Loading history...</div>
          <div v-else-if="messages.length === 0" class="text-sm text-ink/40 select-none">No messages yet. Send one below.</div>
          <p v-if="composerError && (viewingPhysicalId || !isDirectChat)" class="composer-error" role="alert">{{ composerError }}</p>
          <!-- Segment navigation: view previous (top) -->
          <div v-if="previousPhysicalId && !viewingPhysicalId" class="segment-nav">
            <button class="btn btn-sm segment-nav-btn" @click="viewPreviousSegment">&#8592; View previous session</button>
          </div>
          <template v-for="(msg, idx) in messages" :key="idx">
            <!-- Tool call -->
            <div v-if="msg.event === 'tool_call'" class="tool-group">
              <div class="tool-call-header" @click="toggleToolCall(idx)">
                <span class="tool-icon">&#9881;</span>
                <span class="tool-name">{{ parseToolCall(msg).name }}</span>
                <span v-if="!expandedToolCalls.has(idx)" class="tool-args-summary">{{ parseToolCall(msg).argsSummary }}</span>
                <span class="tool-call-toggle">{{ expandedToolCalls.has(idx) ? '&#9660;' : '&#9654;' }}</span>
              </div>
              <pre v-if="expandedToolCalls.has(idx)" class="tool-call-detail">{{ parseToolCall(msg).argsFull }}</pre>
              <!-- If next message is the matching tool_result, render it inline -->
              <div
                v-if="messages[idx + 1]?.event === 'tool_result'"
                class="tool-result"
                :class="{ collapsed: !expandedToolResults.has(idx + 1) }"
              >
                <div class="tool-result-header" @click="toggleToolResult(idx + 1)">
                  <span class="tool-result-toggle">{{ expandedToolResults.has(idx + 1) ? '&#9660;' : '&#9654;' }}</span>
                  <span class="tool-result-title">Result</span>
                </div>
                <pre class="tool-result-content">{{ messages[idx + 1].content }}</pre>
                <div v-if="messages[idx + 1].usage" class="usage-info">
                  <span class="usage-badge">{{ messages[idx + 1].usage!.promptTokens.toLocaleString() }} <span v-if="usageDelta(idx + 1)" class="usage-delta">(+{{ usageDelta(idx + 1)!.prompt.toLocaleString() }})</span> prompt</span>
                  <span class="usage-badge">{{ messages[idx + 1].usage!.completionTokens.toLocaleString() }} <span v-if="usageDelta(idx + 1)" class="usage-delta">(+{{ usageDelta(idx + 1)!.completion.toLocaleString() }})</span> completion</span>
                  <span class="usage-badge total">{{ messages[idx + 1].usage!.totalTokens.toLocaleString() }} <span v-if="usageDelta(idx + 1)" class="usage-delta">(+{{ usageDelta(idx + 1)!.total.toLocaleString() }})</span> total</span>
                </div>
              </div>
            </div>
            <!-- Tool result (standalone, skip if already rendered with its tool_call above) -->
            <div
              v-else-if="msg.event === 'tool_result' && messages[idx - 1]?.event !== 'tool_call'"
              class="tool-group"
            >
              <div
                class="tool-result"
                :class="{ collapsed: !expandedToolResults.has(idx) }"
              >
                <div class="tool-result-header" @click="toggleToolResult(idx)">
                  <span class="tool-result-toggle">{{ expandedToolResults.has(idx) ? '&#9660;' : '&#9654;' }}</span>
                  <span class="tool-result-title">{{ msg.toolName ? `${msg.toolName} result` : 'Tool result' }}</span>
                </div>
                <pre class="tool-result-content">{{ msg.content }}</pre>
              </div>
            </div>
            <!-- Skip tool_result that was already rendered paired with tool_call above -->
            <template v-else-if="msg.event === 'tool_result' && messages[idx - 1]?.event === 'tool_call'" />
            <!-- System event (not a user message) -->
            <div
              v-else-if="msg.role === 'user' && msg.isSystemEvent"
              class="system-event"
              :class="{ expanded: expandedEvents.has(idx) }"
            >
              <div class="system-event-header" @click="toggleEvent(idx)">
                <span class="system-event-type">{{ msg.eventMeta?.type ?? 'event' }}</span>
                <span class="system-event-source">{{ msg.eventMeta?.source ?? 'system' }}</span>
                <span v-if="msg.eventMeta?.attrs?.status" class="system-event-status" :class="msg.eventMeta.attrs.status">{{ msg.eventMeta.attrs.status }}</span>
                <span class="system-event-toggle">{{ expandedEvents.has(idx) ? '&#9660;' : '&#9654;' }}</span>
              </div>
              <div v-if="msg.eventMeta?.attrs?.title && !expandedEvents.has(idx)" class="system-event-title">{{ msg.eventMeta.attrs.title }}</div>
              <div v-if="expandedEvents.has(idx)" class="system-event-body">
                <div v-if="msg.eventMeta?.attrs" class="system-event-attrs">
                  <div v-for="(val, key) in msg.eventMeta.attrs" :key="key" class="system-event-attr">
                    <span class="system-event-attr-key">{{ key }}</span>
                    <span class="system-event-attr-val">{{ val }}</span>
                  </div>
                </div>
                <div v-if="msg.content" class="system-event-content prose" v-html="renderMarkdown(msg.content)" />
              </div>
            </div>
            <!-- Compaction summary (previous conversation context) -->
            <div
              v-else-if="msg.isSummary"
              class="compaction-summary"
            >
              <div class="compaction-summary-header">
                <span class="compaction-summary-title">Previous Conversation Summary</span>
              </div>
              <div class="compaction-summary-body" v-html="renderMarkdown(msg.content)" />
            </div>
            <!-- Normal messages -->
            <div
              v-else
              class="chat-bubble"
              :class="[
                msg.role === 'user' ? 'chat-user' : 'chat-assistant',
                { 'has-selection': msg.role === 'assistant' && selectedMsgIndex === idx },
              ]"
              :data-msg-idx="idx"
              role="article"
              :aria-label="msg.role === 'user' ? (msg.senderName ? `Message from ${msg.senderName}` : 'User message') : 'Assistant message'"
            >
              <div v-if="msg.role === 'user' && msg.senderName" class="chat-sender">{{ msg.senderName }}</div>
              <!-- Reasoning / thinking content (collapsible) -->
              <div v-if="msg.reasoningContent || msg.reasoningText" class="thinking-block">
                <div class="thinking-header" @click="toggleThinking(idx)">
                  <span class="thinking-icon">&#128161;</span>
                  <span class="thinking-label">Thinking</span>
                  <span class="thinking-toggle">{{ expandedThinking.has(idx) ? '&#9660;' : '&#9654;' }}</span>
                </div>
                <div v-if="expandedThinking.has(idx)" class="thinking-content prose" v-html="renderMarkdown(msg.reasoningContent || msg.reasoningText || '')" />
              </div>
              <div class="chat-content prose" v-html="renderMarkdown(msg.content)" />
              <div
                v-if="isErrorMessage(msg) && idx === messages.length - 1 && !streaming"
                class="retry-row"
              >
                <button class="btn btn-sm retry-btn" @click="retryLastRequest">&#8635; Retry</button>
              </div>
              <div v-if="msg.media?.length" class="chat-media">
                <template v-for="(src, mIdx) in msg.media" :key="mIdx">
                  <img
                    v-if="resolveMediaUrl(src)"
                    :src="resolveMediaUrl(src)!"
                    class="chat-media-img"
                    loading="lazy"
                    @click="openMediaUrl(src)"
                  />
                </template>
              </div>
              <div class="chat-footer">
              <div v-if="msg.usage" class="usage-info">
                <span class="usage-badge">{{ msg.usage.promptTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.prompt.toLocaleString() }})</span> prompt</span>
                <span class="usage-badge">{{ msg.usage.completionTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.completion.toLocaleString() }})</span> completion</span>
                <span class="usage-badge total">{{ msg.usage.totalTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.total.toLocaleString() }})</span> total</span>
              </div>
              <MessageTimestamp :timestamp="msg.timestamp" />
              </div>
            </div>
          </template>
          <!-- Streaming: tool calls -->
          <div v-if="streamingToolCall" class="tool-group">
            <div class="tool-call-label">
              <span class="tool-icon">&#9881;</span>
              <span class="tool-args">{{ streamingToolCall }}</span>
            </div>
          </div>
          <!-- Streaming: tool results -->
          <div v-if="streamingToolResult" class="tool-group">
            <div
              class="tool-result"
              :class="{ collapsed: !streamToolResultExpanded }"
            >
              <div class="tool-result-header" @click="streamToolResultExpanded = !streamToolResultExpanded">
                <span class="tool-result-toggle">{{ streamToolResultExpanded ? '&#9660;' : '&#9654;' }}</span>
                <span class="tool-result-title">Result</span>
              </div>
              <pre class="tool-result-content">{{ streamingToolResult }}</pre>
            </div>
          </div>
          <!-- Streaming response -->
          <div v-if="streaming && streamContent" class="chat-bubble chat-assistant" role="article" aria-label="Assistant message">
            <div class="chat-content">
              <span>{{ streamContent }}</span>
            </div>
            <div class="chat-footer"><MessageTimestamp :timestamp="streamTimestamp" /></div>
          </div>
          <!-- Segment navigation: back to current + view older (bottom) -->
          <div v-if="viewingPhysicalId" class="segment-nav">
            <button class="btn btn-sm segment-nav-btn" @click="goBackToCurrentSegment">Back to current &#8594;</button>
            <span class="segment-nav-label">Viewing previous session</span>
            <button v-if="previousPhysicalId" class="btn btn-sm segment-nav-btn" @click="viewPreviousSegment">&#8592; View older session</button>
          </div>
        </div>
        <MessageHistoryRail :entries="historyMarkers" :container="messagesContainer" />
        </div>
        <div v-if="sessionWorking && !viewingPhysicalId && activePanel === 'conversation'" class="chat-working" :class="sessionStage" role="status" aria-live="polite">
          <SessionActivity :stage="sessionStage" />
          <span class="chat-working-detail">{{ sessionStage === 'tool' ? (streamingToolCallData?.name || 'Running a tool call') : 'The agent is working on your request' }}</span>
          <span class="working-wave" aria-hidden="true"><i /><i /><i /></span>
        </div>
      </template>

        <!-- Input (direct-chat only) -->
        <div v-if="(!activeSessionId || isDirectChat) && !viewingPhysicalId" v-show="activePanel === 'conversation'" class="chat-composer">
          <div v-if="canResend" class="resend-bar">
            <button class="resend-btn" @click="resendLastMessage()">&#8635; Resend last message</button>
          </div>
          <div class="composer-box">
          <!-- Selection indicator -->
          <div v-if="selectedText" class="selection-indicator">
            <div class="selection-preview" @click="scrollToSelection">
              <span class="selection-text">"{{ truncateText(selectedText, 120) }}"</span>
            </div>
            <button class="selection-dismiss" @click="clearSelection">&times;</button>
          </div>
          <div v-if="contextItems.length" class="composer-context" aria-label="Attached context">
            <span v-for="(item, index) in contextItems" :key="`${item.kind}:${item.path}`" class="context-chip" :title="item.path">
              <span class="context-icon" :class="item.kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file'" aria-hidden="true" />
              <span>{{ chatContextName(item.path) }}</span>
              <button :disabled="streaming || preparingSend" :aria-label="`Remove ${chatContextName(item.path)}`" @click="contextItems.splice(index, 1)">&times;</button>
            </span>
          </div>
          <div class="composer-input">
            <textarea
              ref="chatInput"
              v-model="inputText"
              placeholder="Ask anything, or add files and folders for context..."
              aria-label="Message"
              rows="3"
              :disabled="streaming || preparingSend"
              @keydown="handleKeyDown"
              @input="autoResize"
            />
          </div>
          <div class="composer-toolbar">
            <div class="composer-controls">
              <ComposerPopover label="Add context" :title="canPickContext ? 'Add files or folders as context' : 'File and folder context requires the local Main desktop app'" :disabled="!canPickContext || pickingContext || streaming || preparingSend" :width="220">
                <template #trigger><span class="i-lucide-plus w-5 h-5" aria-hidden="true" /></template>
                <template #default="{ close }">
                  <button class="context-action" @click="close(); pickContext('file')">
                    <span class="context-icon i-lucide-file-plus" aria-hidden="true" />
                    Add file
                  </button>
                  <button class="context-action" @click="close(); pickContext('folder')">
                    <span class="context-icon i-lucide-folder-plus" aria-hidden="true" />
                    Add folder
                  </button>
                </template>
              </ComposerPopover>
              <ModelSelector />
            </div>
            <div v-if="selectedText" class="composer-send-actions">
              <button
                class="btn"
                :disabled="!canSend"
                @click="askInline"
              >
                Send
              </button>
              <button
                class="btn btn-fork"
                :disabled="!canSend"
                @click="askInFork"
              >
                Ask BTW
              </button>
            </div>
            <button
              v-else
              class="composer-send"
              :disabled="!canSend"
              aria-label="Send message"
              :title="preparingSend ? 'Starting conversation...' : 'Send message'"
              @click="sendMessage()"
            >
              <span class="i-lucide-arrow-up w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          </div>
          <p v-if="composerError" class="composer-error" role="alert">{{ composerError }}</p>
          <div class="composer-hint">{{ pickingContext ? 'Choosing context...' : preparingSend ? 'Starting conversation...' : 'Enter to send · Shift+Enter for a new line' }}</div>
        </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import katex from 'katex'
import { buildMediaUrl } from '../media-url.ts'
import SessionDiagnosis from './SessionDiagnosis.vue'
import type { ToolDef } from './ToolsCard.vue'
import ModelSelector from './ModelSelector.vue'
import ComposerPopover from './ComposerPopover.vue'
import MessageHistoryRail from './MessageHistoryRail.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import SessionActivity from './SessionActivity.vue'
import ProjectsSidebar from './ProjectsSidebar.vue'
import { parseSessionGraph, type SidebarSession } from '../projects-sidebar.ts'
import { createProjectsClient, type ProjectRecord } from '../projects-client.ts'
import { addChatContext, chatContextName, composeChatMessage, createChatDraft, type ChatContextItem } from '../chat-draft.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { userMessageMarkers } from '../message-history.ts'
import { isWorkingStage, parseSessionStages, type SessionStage, type WorkingStage } from '../session-activity.ts'
import { canRedirectComposerKey, isComposerTypingKey } from '../composer-autofocus.ts'
import { groupSenderNames } from '../message-author.ts'

const route = useRoute()
const router = useRouter()

marked.setOptions({ breaks: true })
marked.use({
  renderer: {
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : ''
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

// Allow KaTeX/MathML tags and attributes through DOMPurify
const KATEX_TAGS = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
  'msup', 'msub', 'msubsup', 'mfrac', 'mover', 'munder', 'munderover',
  'mtable', 'mtr', 'mtd', 'msqrt', 'mroot', 'mspace', 'mpadded', 'menclose',
  'mstyle', 'mglyph', 'mmultiscripts', 'mprescripts', 'none',
]
const KATEX_ATTRS = ['mathvariant', 'encoding', 'xmlns', 'display', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing', 'rowlines', 'rowspacing', 'frame', 'framespacing', 'rowalign', 'columnwidth', 'width', 'height', 'depth', 'voffset', 'linethickness', 'scriptlevel', 'minsize', 'maxsize', 'movablelimits', 'notation', 'aria-hidden']

const props = defineProps<{ apiBase: string }>()

const installation = useInstallationContext()
const projectsClient = createProjectsClient(props.apiBase)
const draft = shallowRef(createChatDraft(projectsClient))
const contextItems = ref<ChatContextItem[]>([])
const composerError = ref('')
const preparingSend = ref(false)
const pickingContext = ref(false)
const canPickContext = computed(() => installation.value.mode === 'main' && !!window.shadowDesktop?.chatContext)
const canSend = computed(() => (!!inputText.value.trim() || contextItems.value.length > 0) && !streaming.value && !preparingSend.value && !pickingContext.value)
let sendRequest: AbortController | undefined
let historyRequest: AbortController | undefined
const activeSessionId = ref('')
let sessionSelectionGeneration = 0
const isDirectChat = computed(() => {
  const id = activeSessionId.value
  return id.startsWith('web:chat-')
})
const chatInput = ref<HTMLTextAreaElement>()
const messagesContainer = ref<HTMLElement>()
const loadingHistory = ref(false)
const streaming = ref(false)
const streamPhase = ref<WorkingStage>()
const streamContent = ref('')
const streamTimestamp = ref<string>()
const streamingToolCall = ref('')
const streamingToolCallData = ref<{ name: string; arguments: Record<string, unknown> } | null>(null)
const streamingToolResult = ref('')
const streamToolResultExpanded = ref(false)
const inputText = ref('')
const mobileSidebarOpen = ref(false)

// ── Session stage polling (batch) ────────────────────────────────────────────
const sessionStages = ref<Record<string, SessionStage>>({})
const stageError = ref('')
const displayedSessionStages = computed(() => {
  if (!activeSessionId.value || !streaming.value) return sessionStages.value
  return { ...sessionStages.value, [activeSessionId.value]: streamPhase.value ?? 'llm' }
})
const sessionStage = computed<SessionStage | null>(() =>
  activeSessionId.value ? (displayedSessionStages.value[activeSessionId.value] ?? null) : null,
)
const sessionWorking = computed(() => isWorkingStage(sessionStage.value))
const activeSessionConfig = computed<SessionConfigInfo>(() => {
  const session = activeSessionId.value
    ? allSessions.value.find(s => s.sessionId === activeSessionId.value)?.config
    : undefined
  const g = globalConfig.value
  return {
    model: session?.model ?? g.model ?? (g.provider ? `${g.provider} (default)` : undefined),
    thinking: session?.thinking ?? g.thinking,
    reasoningEffort: session?.reasoningEffort ?? g.reasoningEffort,
  }
})
let stageInterval: ReturnType<typeof setInterval> | null = null
let stageRequest: AbortController | undefined

async function pollSessionStages(): Promise<void> {
  if (stageRequest) return
  const controller = new AbortController()
  stageRequest = controller
  try {
    const res = await fetch(buildUrl('/api/sessions/stages'), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) })
    if (!res.ok) throw new Error('Session activity is unavailable.')
    const stages = parseSessionStages(await res.json())
    if (!controller.signal.aborted) {
      sessionStages.value = stages
      stageError.value = ''
    }
  } catch {
    if (!controller.signal.aborted) {
      sessionStages.value = {}
      stageError.value = 'Session activity is unavailable. Retrying...'
    }
  } finally {
    if (stageRequest === controller) stageRequest = undefined
  }
}

function startStagePolling(): void {
  stopStagePolling()
  void pollSessionStages()
  stageInterval = setInterval(pollSessionStages, 1500)
}

function stopStagePolling(): void {
  if (stageInterval) { clearInterval(stageInterval); stageInterval = null }
  stageRequest?.abort()
  stageRequest = undefined
  sessionStages.value = {}
}

// ── Background event stream (live push for cron ticks / self-awake / subagents) ──
// A persistent SSE connection kept open for the active direct chat so messages
// triggered outside a user request (scheduled events, subagent replies) render
// live without a manual page refresh.
let eventStream: EventSource | null = null
let bgStreamState: StreamState = { accumulated: '' }

function connectEventStream(chatId: string): void {
  disconnectEventStream()
  bgStreamState = { accumulated: '' }
  const es = new EventSource(buildUrl('/api/chat/events', { chatId }))
  eventStream = es
  es.onmessage = (ev) => {
    if (eventStream !== es || activeSessionId.value !== `web:${chatId}`) return
    if (!ev.data) return
    // Never render live pushes into a historical-segment view.
    if (viewingPhysicalId.value) return
    try {
      const payload = JSON.parse(ev.data)
      streaming.value = true
      if (applyStreamPayload(payload, bgStreamState)) {
        streaming.value = false
        void loadSessionList()
      }
    } catch { /* ignore malformed data lines */ }
  }
  es.onerror = () => {
    // EventSource reconnects automatically; nothing to do.
  }
}

function disconnectEventStream(): void {
  if (eventStream) {
    eventStream.close()
    eventStream = null
  }
  bgStreamState.accumulated = ''
  bgStreamState.timestamp = undefined
  streamTimestamp.value = undefined
}

function autoResize() {
  const el = chatInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
const systemPrompt = ref('')
const tools = ref<ToolDef[]>([])

/**
 * Latest compaction summary for the current segment, if any.
 * After a sleep/compact, the new physical session log starts with a
 * synthesized summary_context which is rendered as a `__compaction_summary__`
 * user message (see session-manager.parseSessionLog). We surface it as a
 * dedicated diagnosis card so users can see the full session context the
 * LLM sees on each turn without scrolling through chat history.
 */
const compactionSummary = computed(() => {
  for (const msg of messages.value) {
    if (msg.isSummary && msg.content) return msg.content
  }
  return ''
})

const activePanel = ref<'conversation' | 'diagnosis'>('conversation')
const diagnosisOpened = ref(false)
function switchPanel(panel: 'conversation' | 'diagnosis'): void {
  activePanel.value = panel
  if (panel === 'diagnosis') diagnosisOpened.value = true
}
function handlePanelKey(event: KeyboardEvent, panel: 'conversation' | 'diagnosis'): void {
  const next = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    ? (panel === 'conversation' ? 'diagnosis' : 'conversation')
    : event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'diagnosis' : undefined
  if (!next) return
  event.preventDefault()
  switchPanel(next)
  document.getElementById(`${next}-tab`)?.focus()
}
const globalConfig = ref<{ model?: string; provider?: string; thinking?: { type: 'enabled' | 'disabled' }; reasoningEffort?: 'high' | 'max' }>({})
interface SessionConfigInfo {
  model?: string
  thinking?: { type: 'enabled' | 'disabled' }
  reasoningEffort?: 'high' | 'max'
}

interface ChatMsg {
  role: string
  content: string
  senderName?: string
  timestamp?: string
  event?: string
  toolName?: string
  toolCall?: { name: string; arguments: Record<string, unknown> }
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  media?: string[]
  /** Round-trippable reasoning (DeepSeek). */
  reasoningContent?: string
  /** Display-only reasoning narration (Copilot `reasoning_text`, OpenAI `reasoning`). */
  reasoningText?: string
  /** True for system events (subagent-complete, heartbeat, etc.) — rendered differently from user messages. */
  isSystemEvent?: boolean
  /** Parsed event metadata: type, source name, and all XML attributes from the <event .../> tag. */
  eventMeta?: { type: string; source: string; attrs: Record<string, string> }
  /** True for compaction summary messages — the first message after a session compact. */
  isSummary?: boolean
  /** True when this bubble is a failed-request notice that can be retried. */
  isError?: boolean
}

const messages = ref<ChatMsg[]>([])
const allSessions = ref<SidebarSession[]>([])
const sessionsLoading = ref(false)
const sessionsError = ref('')
let sessionListRequest: AbortController | undefined
const collapsedSessions = reactive(new Set<string>())
const expandedToolResults = reactive(new Set<number>())
const expandedToolCalls = reactive(new Set<number>())
const expandedEvents = reactive(new Set<number>())
const expandedThinking = reactive(new Set<number>())

// ── Segment navigation state ─────────────────────────────────────────────────
const previousPhysicalId = ref<string | null>(null)
const viewingPhysicalId = ref<string | null>(null)
const physicalIdStack = ref<string[]>([])

// ── Text selection state ──────────────────────────────────────────────────────
const selectedText = ref('')
const selectedMsgIndex = ref(-1)
const selectedElement = ref<HTMLElement | null>(null)

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, props.apiBase)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

function toggleToolResult(idx: number): void {
  clearSelection()
  if (expandedToolResults.has(idx)) {
    expandedToolResults.delete(idx)
  } else {
    expandedToolResults.add(idx)
  }
}

function toggleToolCall(idx: number): void {
  clearSelection()
  if (expandedToolCalls.has(idx)) {
    expandedToolCalls.delete(idx)
  } else {
    expandedToolCalls.add(idx)
  }
}

function toggleEvent(idx: number): void {
  clearSelection()
  if (expandedEvents.has(idx)) {
    expandedEvents.delete(idx)
  } else {
    expandedEvents.add(idx)
  }
}

function toggleThinking(idx: number): void {
  clearSelection()
  if (expandedThinking.has(idx)) {
    expandedThinking.delete(idx)
  } else {
    expandedThinking.add(idx)
  }
}

/** Parse tool call into name and formatted args. Uses structured toolCall data when available. */
function parseToolCall(msg: ChatMsg): { name: string; argsSummary: string; argsFull: string } {
  if (msg.toolCall) {
    const { name, arguments: args } = msg.toolCall
    const argsFull = JSON.stringify(args, null, 2)
    const argsSummary = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ')
    return { name, argsSummary, argsFull }
  }
  // Fallback: parse from content string "name({...json...})"
  const content = msg.content
  const parenIdx = content.indexOf('(')
  if (parenIdx === -1) return { name: content, argsSummary: '', argsFull: '' }
  const name = content.slice(0, parenIdx)
  const argsRaw = content.slice(parenIdx + 1, content.endsWith(')') ? -1 : undefined)
  let argsFull = argsRaw
  let argsSummary = argsRaw
  try {
    const parsed = JSON.parse(argsRaw)
    argsFull = JSON.stringify(parsed, null, 2)
    argsSummary = Object.entries(parsed)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ')
  } catch { /* use raw */ }
  return { name, argsSummary, argsFull }
}

// ── History collapsing (from raw ChatMessage[] to ChatMsg[]) ─────────────────

/** Strip `<sender ... />` and `<event ... />` XML metadata tags from text. */
const META_TAG_RE = /^<(?:sender|event)\s[^>]*\/>\s*/
/** Detect `<event ... />` metadata tag (system event, not a user message). */
const EVENT_TAG_RE = /^<event\s/
/** Match `MEDIA:<path-or-url>` lines in assistant content. */
const MEDIA_LINE_RE = /^MEDIA:(\S+)$/gm

interface RawMessage {
  role: string
  timestamp?: string
  content: string | Array<{ type: string; text?: string }> | null
  reasoning_content?: string | null
  reasoning_text?: string | null
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

function rawTextContent(msg: RawMessage, stripMeta = false): string {
  let text: string
  if (typeof msg.content === 'string') {
    text = msg.content
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
  } else {
    text = ''
  }
  if (stripMeta) text = text.replace(META_TAG_RE, '')
  return text
}

/** Parse `<event type="..." key="val" ... />` tag into attributes map. Returns null if not an event tag. */
const EVENT_ATTR_RE = /(\w[\w-]*)="([^"]*)"/g
function parseEventTag(text: string): Record<string, string> | null {
  if (!EVENT_TAG_RE.test(text)) return null
  // Extract the tag itself
  const tagMatch = text.match(/^<event\s([^>]*)\/>/)
  if (!tagMatch) return null
  const attrs: Record<string, string> = {}
  let m: RegExpExecArray | null
  EVENT_ATTR_RE.lastIndex = 0
  while ((m = EVENT_ATTR_RE.exec(tagMatch[1])) !== null) {
    attrs[m[1]] = m[2]
  }
  return attrs
}

/** Check if the first content part starts with `<event .../>`. Returns parsed attrs + source if true. */
function detectEvent(msg: RawMessage): { attrs: Record<string, string>; source: string } | null {
  if (msg.role !== 'user') return null
  let firstText: string | undefined
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const first = msg.content[0]
    if (first.type === 'text' && first.text) firstText = first.text
  } else if (typeof msg.content === 'string') {
    firstText = msg.content
  }
  if (!firstText) return null
  const attrs = parseEventTag(firstText)
  if (!attrs) return null
  return { attrs, source: msg.name ?? attrs.kind ?? 'system' }
}

/** Extract `MEDIA:<path>` lines from text, returning cleaned text + media array. */
function extractMedia(text: string): { text: string; media: string[] } {
  const media: string[] = []
  const cleaned = text.replace(MEDIA_LINE_RE, (_match, path) => {
    media.push(path)
    return ''
  }).replace(/^\s*\n|\n\s*$/g, '')
  return { text: cleaned, media }
}

function collapseHistory(raw: RawMessage[]): ChatMsg[] {
  const out: ChatMsg[] = []
  const senderNames = groupSenderNames(raw, isDirectChat.value)
  let i = 0

  while (i < raw.length) {
    const msg = raw[i]

    if (msg.role === 'system') { i++; continue }

    if (msg.role === 'user') {
      const ev = detectEvent(msg)
      const content = rawTextContent(msg, true)
      if (msg.name === '__compaction_summary__') {
        out.push({ role: 'user', content, isSummary: true })
      } else if (ev) {
        out.push({
          role: 'user',
          content,
          isSystemEvent: true,
          eventMeta: { type: ev.attrs.type ?? 'event', source: ev.source, attrs: ev.attrs },
        })
      } else {
        out.push({ role: 'user', content, senderName: senderNames[i], timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : undefined })
      }
      i++
      continue
    }

    if (msg.role === 'assistant') {
      while (i < raw.length && (raw[i].role === 'assistant' || raw[i].role === 'tool')) {
        const cur = raw[i]

        if (cur.role === 'assistant') {
          const rawText = rawTextContent(cur)
          if (rawText) {
            const { text, media } = extractMedia(rawText)
            const entry: ChatMsg = { role: 'assistant', content: text, timestamp: cur.timestamp }
            if (cur.usage) entry.usage = cur.usage
            if (media.length > 0) entry.media = media
            if (cur.reasoning_content) entry.reasoningContent = cur.reasoning_content
            if (cur.reasoning_text) entry.reasoningText = cur.reasoning_text
            out.push(entry)
          }
          if (cur.tool_calls?.length) {
            // Look ahead to collect tool results keyed by tool_call_id
            const toolResults: Array<{ content: string; name?: string; toolCallId?: string }> = []
            let peek = i + 1
            while (peek < raw.length && raw[peek].role === 'tool') {
              const toolMsg = raw[peek]
              toolResults.push({
                content: rawTextContent(toolMsg),
                name: toolMsg.name,
                toolCallId: toolMsg.tool_call_id,
              })
              peek++
            }
            const resultById = new Map<string, { content: string; name?: string }>()
            for (const tr of toolResults) {
              if (tr.toolCallId) resultById.set(tr.toolCallId, tr)
            }

            // Emit interleaved tool_call → tool_result pairs
            for (let j = 0; j < cur.tool_calls.length; j++) {
              const tc = cur.tool_calls[j]
              let parsedArgs: Record<string, unknown> = {}
              try { parsedArgs = JSON.parse(tc.function.arguments) } catch { /* use empty */ }
              out.push({
                role: 'assistant',
                content: `${tc.function.name}(${tc.function.arguments})`,
                event: 'tool_call',
                toolName: tc.function.name,
                toolCall: { name: tc.function.name, arguments: parsedArgs },
              })
              const result = resultById.get(tc.id) ?? toolResults[j]
              if (result?.content) {
                const entry: ChatMsg = {
                  role: 'assistant',
                  content: result.content,
                  event: 'tool_result',
                  toolName: result.name,
                }
                // Attach usage to the last tool_result when assistant had no text content
                if (cur.usage && !rawText && j === cur.tool_calls.length - 1) {
                  entry.usage = cur.usage
                }
                out.push(entry)
              }
            }

            // Skip past consumed tool messages
            i = peek
            continue
          }
        } else if (cur.role === 'tool') {
          const result = rawTextContent(cur)
          if (result) {
            out.push({
              role: 'assistant',
              content: result,
              event: 'tool_result',
              toolName: cur.name,
            })
          }
        }

        i++
      }
      continue
    }

    i++
  }

  return out
}

// ── Session list ──────────────────────────────────────────────────────────────

async function loadGlobalConfig(): Promise<void> {
  try {
    const res = await fetch(buildUrl('/api/config'))
    if (res.ok) {
      const data = await res.json()
      globalConfig.value = {
        model: data.agent?.model,
        provider: data.agent?.provider,
        thinking: data.agent?.thinking,
        reasoningEffort: data.agent?.reasoningEffort,
      }
    }
  } catch { /* ignore */ }
}

async function loadSessionList(): Promise<void> {
  sessionListRequest?.abort()
  const controller = new AbortController()
  sessionListRequest = controller
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    const res = await fetch(buildUrl('/api/sessions/graph'), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!res.ok) throw new Error('Cannot load conversations. Check Main and retry.')
    const data = await res.json()
    if (!controller.signal.aborted) allSessions.value = parseSessionGraph(data)
  } catch (cause) {
    if (!controller.signal.aborted) sessionsError.value = cause instanceof Error && cause.message.startsWith('Cannot ')
      ? cause.message : 'Cannot load conversations. Check Main and retry.'
  } finally {
    if (sessionListRequest === controller) {
      sessionListRequest = undefined
      sessionsLoading.value = false
    }
  }
}

function toggleCollapse(sessionId: string): void {
  if (collapsedSessions.has(sessionId)) {
    collapsedSessions.delete(sessionId)
  } else {
    collapsedSessions.add(sessionId)
  }
}

function createNewWebChat(project?: ProjectRecord): void {
  resetConversation()
  draft.value = createChatDraft(projectsClient, project)
  activeSessionId.value = ''
  mobileSidebarOpen.value = false
  void router.replace({ name: 'chat' })
  void nextTick(() => {
    autoResize()
    chatInput.value?.focus({ preventScroll: true })
  })
}

async function pickContext(kind: ChatContextItem['kind']): Promise<void> {
  const picker = window.shadowDesktop?.chatContext
  if (!canPickContext.value || !picker) {
    composerError.value = 'File and folder context requires the local Main desktop app.'
    return
  }
  if (pickingContext.value) return
  const generation = sessionSelectionGeneration
  pickingContext.value = true
  composerError.value = ''
  try {
    const paths = kind === 'file' ? await picker.selectFiles() : await picker.selectFolders()
    if (generation !== sessionSelectionGeneration) return
    contextItems.value = addChatContext(contextItems.value, kind, paths)
  } catch (error) {
    if (generation === sessionSelectionGeneration) composerError.value = error instanceof Error ? error.message : 'Could not select context. Try again.'
  } finally {
    if (generation === sessionSelectionGeneration) {
      pickingContext.value = false
      chatInput.value?.focus({ preventScroll: true })
    }
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  const children = allSessions.value.filter(s => s.parentSessionId === sessionId)
  const msg = children.length > 0
    ? `Delete "${sessionId}" and its ${children.length} child session(s)?`
    : `Delete "${sessionId}"?`
  if (!confirm(msg)) return

  try {
    const res = await fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), { method: 'DELETE' })
    if (!res.ok) {
      sessionsError.value = 'Could not delete this conversation. Check Main and retry.'
      return
    }
    // Clear active view if deleted session was selected
    if (activeSessionId.value === sessionId) {
      createNewWebChat()
    }
    await loadSessionList()
  } catch {
    sessionsError.value = 'Could not delete this conversation. Check Main and retry.'
  }
}

function resetConversation(): void {
  sessionSelectionGeneration++
  activePanel.value = 'conversation'
  diagnosisOpened.value = false
  sendRequest?.abort()
  sendRequest = undefined
  historyRequest?.abort()
  historyRequest = undefined
  loadingHistory.value = false
  preparingSend.value = false
  pickingContext.value = false
  streaming.value = false
  streamPhase.value = undefined
  inputText.value = ''
  contextItems.value = []
  composerError.value = ''
  clearSelection()
  disconnectEventStream()
  messages.value = []
  streamContent.value = ''
  streamTimestamp.value = undefined
  streamingToolCall.value = ''
  streamingToolCallData.value = null
  streamingToolResult.value = ''
  systemPrompt.value = ''
  tools.value = []
  previousPhysicalId.value = null
  viewingPhysicalId.value = null
  physicalIdStack.value = []
  expandedToolResults.clear()
  expandedToolCalls.clear()
  expandedEvents.clear()
  expandedThinking.clear()
}

function selectSession(sessionId: string): void {
  resetConversation()
  activeSessionId.value = sessionId
  void router.replace({ name: 'chat', params: { sessionId } })
  void loadCurrentSession()
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadCurrentSession(): Promise<void> {
  if (!activeSessionId.value) return
  if (isDirectChat.value) {
    await loadDirectChat()
  } else {
    await loadReadonlySession()
  }
}

async function loadDirectChat(): Promise<void> {
  historyRequest?.abort()
  const controller = new AbortController()
  historyRequest = controller
  const chatId = activeSessionId.value.replace('web:', '')
  const sessionId = activeSessionId.value
  loadingHistory.value = true
  try {
    const res = await fetch(buildUrl('/api/chat/session', { chatId }), { signal: controller.signal })
    if (!res.ok) throw new Error('Could not load conversation. Refresh to retry.')
    const data = await res.json()
    if (controller.signal.aborted) return
    messages.value = collapseHistory(data.history ?? [])
    systemPrompt.value = data.systemPrompt ?? ''
    tools.value = data.tools ?? []
    // Also fetch segment info for navigation
    try {
      const segRes = await fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`, { pageSize: '1', shallow: 'true' }), { signal: controller.signal })
      const segData = await segRes.json()
      if (controller.signal.aborted) return
      previousPhysicalId.value = segData.previousPhysicalId ?? null
    } catch { if (!controller.signal.aborted) previousPhysicalId.value = null }
    if (controller.signal.aborted) return
    viewingPhysicalId.value = null
    physicalIdStack.value = []
  } catch (error) {
    if (!controller.signal.aborted) composerError.value = error instanceof Error ? error.message : 'Could not load conversation. Refresh to retry.'
  } finally {
    if (historyRequest === controller) {
      historyRequest = undefined
      loadingHistory.value = false
      scrollToBottom()
    }
  }
  // Keep a live event stream open so background pushes (cron/self-awake/subagent)
  // render without a manual refresh.
  if (!controller.signal.aborted) connectEventStream(chatId)
}

async function loadReadonlySession(): Promise<void> {
  historyRequest?.abort()
  const controller = new AbortController()
  historyRequest = controller
  const sessionId = activeSessionId.value

  // Read-only sessions have no live web input; ensure any event stream is closed.
  disconnectEventStream()
  loadingHistory.value = true
  try {
    // Fetch all history + context in parallel
    const [histRes, ctxRes] = await Promise.all([
      fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`, { shallow: 'true' }), { signal: controller.signal }),
      fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/context`), { signal: controller.signal }),
    ])

    const histData = await histRes.json()
    if (controller.signal.aborted) return
    const rawMessages: RawMessage[] = histData.messages ?? []
    messages.value = collapseHistory(rawMessages)
    previousPhysicalId.value = histData.previousPhysicalId ?? null
    viewingPhysicalId.value = null
    physicalIdStack.value = []

    if (ctxRes.ok) {
      const ctxData = await ctxRes.json()
      if (controller.signal.aborted) return
      systemPrompt.value = ctxData.systemPrompt ?? ''
      tools.value = ctxData.tools ?? []
    }
  } catch {
    if (!controller.signal.aborted) messages.value = []
  } finally {
    if (historyRequest === controller) {
      historyRequest = undefined
      loadingHistory.value = false
      scrollToBottom()
    }
  }
}

// ── Segment navigation ───────────────────────────────────────────────────────

async function viewPreviousSegment(): Promise<void> {
  if (!previousPhysicalId.value) return
  const physId = previousPhysicalId.value
  historyRequest?.abort()
  const controller = new AbortController()
  historyRequest = controller
  loadingHistory.value = true
  try {
    const res = await fetch(buildUrl(`/api/sessions/${encodeURIComponent(physId)}`), { signal: controller.signal })
    if (!res.ok) throw new Error('Could not load this historical segment. Refresh to retry.')
    const data = await res.json()
    if (controller.signal.aborted) return
    const rawMessages: RawMessage[] = data.messages ?? []
    physicalIdStack.value.push(viewingPhysicalId.value ?? '')
    messages.value = collapseHistory(rawMessages)
    viewingPhysicalId.value = physId
    previousPhysicalId.value = data.previousPhysicalId ?? null
    composerError.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) composerError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (historyRequest === controller) {
      historyRequest = undefined
      loadingHistory.value = false
      scrollToBottom()
    }
  }
}

async function goBackToCurrentSegment(): Promise<void> {
  viewingPhysicalId.value = null
  previousPhysicalId.value = null
  physicalIdStack.value = []
  await loadCurrentSession()
}

// ── Send message ──────────────────────────────────────────────────────────────

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    if (selectedText.value) {
      askInline()
    } else {
      sendMessage()
    }
  }
}

/** Streaming accumulator state shared between the active request reader and the
 * persistent background event stream. */
interface StreamState { accumulated: string; timestamp?: string }

/** A decoded SSE payload emitted by the web channel. */
interface StreamPayload {
  event?: 'response' | 'tool_call' | 'tool_result'
  content?: string
  done?: boolean
  media?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  toolCall?: { name: string; arguments: Record<string, unknown> }
}

/**
 * Apply a single decoded SSE payload to the reactive chat state. Shared by the
 * active `/api/chat/send` reader loop and the persistent `/api/chat/events`
 * background stream so both render identically. Returns true when the payload
 * marks the end of a turn (`done`).
 */
function applyStreamPayload(payload: StreamPayload, state: StreamState): boolean {
  const event = payload.event ?? 'response'
  streamPhase.value = event === 'tool_call' ? 'tool' : 'llm'

  if (event === 'tool_call') {
    // Flush any pending response text
    if (state.accumulated) {
      messages.value.push({ role: 'assistant', content: state.accumulated, timestamp: state.timestamp })
      state.accumulated = ''
      state.timestamp = undefined
      streamContent.value = ''
      streamTimestamp.value = undefined
    }
    // Flush previous tool result
    flushStreamingTool()
    streamingToolCall.value = payload.content ?? ''
    streamingToolCallData.value = payload.toolCall ?? null
    scrollToBottom()
  } else if (event === 'tool_result') {
    // Commit the tool_call, show tool_result
    if (streamingToolCall.value || streamingToolCallData.value) {
      const msg: ChatMsg = {
        role: 'assistant',
        content: streamingToolCall.value,
        event: 'tool_call',
      }
      if (streamingToolCallData.value) msg.toolCall = streamingToolCallData.value
      messages.value.push(msg)
      streamingToolCall.value = ''
      streamingToolCallData.value = null
    }
    streamingToolResult.value = payload.content ?? ''
    streamToolResultExpanded.value = false
    scrollToBottom()
  } else {
    // response event
    flushStreamingTool()
    if (payload.content) {
      state.timestamp ??= new Date().toISOString()
      state.accumulated += payload.content
      streamContent.value = state.accumulated
      streamTimestamp.value = state.timestamp
      scrollToBottom()
    }
  }

  if (payload.done) {
    streamPhase.value = undefined
    flushStreamingTool()
    if (state.accumulated) {
      const { text, media } = extractMedia(state.accumulated)
      const msg: ChatMsg = { role: 'assistant', content: text, timestamp: state.timestamp }
      if (payload.usage) msg.usage = payload.usage
      if (payload.media?.length) msg.media = [...(media.length ? media : []), ...payload.media]
      else if (media.length) msg.media = media
      messages.value.push(msg)
    }
    state.accumulated = ''
    state.timestamp = undefined
    streamContent.value = ''
    streamTimestamp.value = undefined
    scrollToBottom()
    return true
  }
  return false
}

async function sendMessage(overrideContent?: string, opts?: { parentSessionId?: string; retry?: boolean; retryContent?: string }): Promise<void> {
  const retry = opts?.retry === true
  const content = retry ? '' : composeChatMessage(overrideContent ?? inputText.value.trim(), contextItems.value)
  if ((!content && !retry) || streaming.value || preparingSend.value || pickingContext.value) return
  const generation = sessionSelectionGeneration
  const controller = new AbortController()
  sendRequest = controller
  const startingDraft = !activeSessionId.value
  preparingSend.value = startingDraft
  composerError.value = ''
  let accepted = false

  try {
    const sessionId = activeSessionId.value || await draft.value.prepare(controller.signal)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    // Never load context/history for a draft: that endpoint materializes a session.
    historyRequest?.abort()
    historyRequest = undefined
    loadingHistory.value = false
    activeSessionId.value = sessionId
    void router.replace({ name: 'chat', params: { sessionId } })
    preparingSend.value = false
    if (!retry) {
      messages.value.push({ role: 'user', content, timestamp: new Date().toISOString() })
      inputText.value = ''
      contextItems.value = []
      if (chatInput.value) chatInput.value.style.height = 'auto'
    }
    clearSelection()
    streaming.value = true
    streamPhase.value = 'llm'
    streamContent.value = ''
    streamTimestamp.value = undefined
    streamingToolCall.value = ''
    streamingToolResult.value = ''
    streamToolResultExpanded.value = false
    scrollToBottom()

    const chatId = sessionId.replace('web:', '')
    const payload: Record<string, unknown> = {
      chatId,
      senderId: 'admin',
    }
    if (retry) {
      payload.retry = true
      // Fallback content used only if the original request never reached the backend.
      if (opts?.retryContent) payload.content = opts.retryContent
    } else {
      payload.content = content
    }
    if (opts?.parentSessionId) payload.parentSessionId = opts.parentSessionId

    const res = await fetch(buildUrl('/api/chat/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(`Could not send message (${res.status} ${res.statusText}). Retry when Main is available.`)
    }
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    accepted = true
    if (!eventStream) connectEventStream(chatId)
    void loadSessionList()

    // Read SSE stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const streamState: StreamState = { accumulated: '' }

    while (true) {
      const { value, done } = await reader.read()
      if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Parse SSE lines
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const payload = JSON.parse(line.slice(6))
          if (applyStreamPayload(payload, streamState)) {
            streaming.value = false
            void loadSessionList()
            return
          }
        } catch { /* skip malformed data lines */ }
      }
    }

    // Stream ended without explicit done
    flushStreamingTool()
    if (streamState.accumulated) {
      messages.value.push({ role: 'assistant', content: streamState.accumulated, timestamp: streamState.timestamp })
    }
  } catch (err) {
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    if (!activeSessionId.value) {
      composerError.value = err instanceof Error ? err.message : 'Could not start the conversation. Retry.'
    } else {
      messages.value.push({ role: 'assistant', content: `Error: ${err}`, isError: true, timestamp: new Date().toISOString() })
    }
  } finally {
    if (generation === sessionSelectionGeneration) {
      if (sendRequest === controller) sendRequest = undefined
      preparingSend.value = false
      streaming.value = false
      streamPhase.value = undefined
      streamContent.value = ''
      streamTimestamp.value = undefined
      streamingToolCall.value = ''
      streamingToolCallData.value = null
      streamingToolResult.value = ''
      scrollToBottom()
      if (accepted && !systemPrompt.value) void loadCurrentSession()
    }
  }
}

/** True when an assistant message is a failed-request notice that can be retried. */
function isErrorMessage(msg: ChatMsg): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.isError === true) return true
  return typeof msg.content === 'string' && msg.content.startsWith('⚠️ Request failed:')
}

/**
 * Retry the last failed request: drop the trailing error notice(s) from the
 * view and re-run the request on the existing history (no duplicate prompt).
 */
function retryLastRequest(): void {
  if (streaming.value) return
  while (messages.value.length && isErrorMessage(messages.value[messages.value.length - 1])) {
    messages.value.pop()
  }
  // The message being retried (last user bubble) is sent as a fallback so the
  // request still works if the original send never reached the backend.
  const last = messages.value[messages.value.length - 1]
  const retryContent = last && last.role === 'user' && typeof last.content === 'string'
    ? last.content
    : undefined
  void sendMessage(undefined, { retry: true, retryContent })
}

/** Commit any in-flight streaming tool call/result into the messages array. */
function flushStreamingTool(): void {
  if (streamingToolCall.value || streamingToolCallData.value) {
    const msg: ChatMsg = {
      role: 'assistant',
      content: streamingToolCall.value,
      event: 'tool_call',
    }
    if (streamingToolCallData.value) msg.toolCall = streamingToolCallData.value
    messages.value.push(msg)
    streamingToolCall.value = ''
    streamingToolCallData.value = null
  }
  if (streamingToolResult.value) {
    messages.value.push({
      role: 'assistant',
      content: streamingToolResult.value,
      event: 'tool_result',
    })
    streamingToolResult.value = ''
    streamToolResultExpanded.value = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scrollToBottom(): void {
  nextTick(() => {
    if (activePanel.value !== 'conversation') return
    const el = messagesContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** Compute token delta from previous assistant message with usage. */
function usageDelta(idx: number): { prompt: number; completion: number; total: number } | null {
  const cur = messages.value[idx]?.usage
  if (!cur) return null
  for (let i = idx - 1; i >= 0; i--) {
    const prev = messages.value[i].usage
    if (prev) {
      return {
        prompt: cur.promptTokens - prev.promptTokens,
        completion: cur.completionTokens - prev.completionTokens,
        total: cur.totalTokens - prev.totalTokens,
      }
    }
  }
  return null
}

const FILE_REF_RE = /\[file:\s*([^\]]+)\]/g
const IMAGE_EXT_SET = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'avif', 'heic', 'heif'])

function preprocessFileRefs(text: string): string {
  return text.replace(FILE_REF_RE, (_match, rawPath: string) => {
    const path = rawPath.trim()
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    if (IMAGE_EXT_SET.has(ext)) {
      const url = resolveMediaUrl(path)
      if (!url) return _match
      return `<img src="${url}" alt="${path}" class="chat-inline-img" loading="lazy" />`
    }
    return _match
  })
}

function preprocessCustomXml(text: string): string {
  text = preprocessFileRefs(text)
  text = text.replace(
    /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g,
    (_match, inner: string) => {
      const skills = [...inner.matchAll(/<skill\s+name="([^"]*)">([\s\S]*?)<\/skill>/g)]
      const categories = [...inner.matchAll(/<category\s+name="([^"]*)"\s+count="([^"]*)"\s+skills="([^"]*)">([\s\S]*?)<\/category>/g)]
      if (skills.length === 0 && categories.length === 0) return ''

      const lines: string[] = []

      // Core / uncategorized skills
      if (skills.length > 0) {
        lines.push(...skills.map(([, name, desc]) => `- **${name}** — ${desc.trim()}`))
      }

      // Categorized skill groups
      if (categories.length > 0) {
        for (const [, catName, count, skillNames, desc] of categories) {
          lines.push(`- **${catName}** (${count}) — ${desc.trim()}`)
          lines.push(`  <sub>${skillNames}</sub>`)
        }
      }

      return '### Available Skills\n\n' + lines.join('\n')
    },
  )
  text = text.replace(
    /<available_agent_types>\s*([\s\S]*?)\s*<\/available_agent_types>/g,
    (_match, inner: string) => {
      const items = [...inner.matchAll(/<agent_type\s+name="([^"]*)">([\s\S]*?)<\/agent_type>/g)]
      if (items.length === 0) return ''
      const lines = items.map(([, name, desc]) => `- **${name}** — ${desc.trim()}`)
      return '### Available Agent Types\n\n' + lines.join('\n')
    },
  )
  return text
}

function renderMarkdown(text: string): string {
  if (!text) return ''

  // Pre-render math with KaTeX before marked processes the text,
  // so marked never touches LaTeX backslash commands.
  const mathBlocks: string[] = []
  let src = preprocessCustomXml(text)

  // Display math: $$...$$  (may span multiple lines)
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }))
    } catch { mathBlocks.push(`$$${math}$$`) }
    return `\x00MATH${idx}\x00`
  })

  // Inline math: $...$  (single line only)
  src = src.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }))
    } catch { mathBlocks.push(`$${math}$`) }
    return `\x00MATH${idx}\x00`
  })

  let html = marked.parse(src, { async: false }) as string

  // Restore rendered math blocks
  html = html.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathBlocks[parseInt(i)])

  return DOMPurify.sanitize(html, {
    ADD_TAGS: [...KATEX_TAGS, 'img'],
    ADD_ATTR: [...KATEX_ATTRS, 'target', 'rel', 'src', 'alt', 'loading', 'class'],
  })
}

/** Resolve a media path (absolute or workspace-relative) to a servable URL. */
function resolveMediaUrl(path: string): string | null {
  return buildMediaUrl(props.apiBase, activeSessionId.value, path)
}

function openMediaUrl(path: string): void {
  const url = resolveMediaUrl(path)
  if (url) globalThis.open(url, '_blank')
}

// ── Text selection handling ───────────────────────────────────────────────────

const highlightRects = ref<Array<{ top: number; left: number; width: number; height: number }>>([])

/** Compute overlay rects from the current browser selection, relative to the messages container. */
function captureHighlightRects(sel: Selection): void {
  highlightRects.value = []
  if (sel.rangeCount === 0 || !messagesContainer.value) return

  const range = sel.getRangeAt(0)
  const containerRect = messagesContainer.value.getBoundingClientRect()
  const scrollTop = messagesContainer.value.scrollTop
  const scrollLeft = messagesContainer.value.scrollLeft

  // Collect all raw client rects
  const raw: Array<{ top: number; left: number; width: number; height: number; right: number; bottom: number }> = []
  for (const r of range.getClientRects()) {
    if (r.width === 0 || r.height === 0) continue
    raw.push({
      top: r.top - containerRect.top + scrollTop,
      left: r.left - containerRect.left + scrollLeft,
      width: r.width,
      height: r.height,
      right: r.right - containerRect.left + scrollLeft,
      bottom: r.bottom - containerRect.top + scrollTop,
    })
  }

  // Remove rects that fully contain a smaller rect (keep only the tightest)
  const filtered = raw.filter((a) => {
    return !raw.some((b) =>
      a !== b &&
      a.top <= b.top && a.left <= b.left &&
      a.right >= b.right && a.bottom >= b.bottom
    )
  })

  highlightRects.value = filtered.map(({ top, left, width, height }) => ({ top, left, width, height }))
}

function handleTextSelection(): void {
  if (route.name !== 'chat' || activePanel.value !== 'conversation') return
  if (!isDirectChat.value) return // readonly sessions – no selection actions
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return

  // Walk up from the selection anchor to find if it's inside a selectable area
  let node: Node | null = sel.anchorNode
  let msgEl: HTMLElement | null = null
  let isAssistant = false
  while (node && node !== messagesContainer.value) {
    if (node instanceof HTMLElement) {
      // Assistant chat bubble
      if (node.dataset.msgIdx !== undefined && node.classList.contains('chat-assistant')) {
        msgEl = node
        isAssistant = true
        break
      }
      // System event (expanded body content)
      if (node.classList.contains('system-event') && node.classList.contains('expanded')) {
        msgEl = node
        break
      }
      // Tool result content (only when expanded)
      if (node.classList.contains('tool-result') && !node.classList.contains('collapsed')) {
        msgEl = node
        break
      }
    }
    node = node.parentNode
  }
  if (!msgEl) return

  selectedText.value = sel.toString().trim()
  selectedMsgIndex.value = isAssistant ? parseInt(msgEl.dataset.msgIdx!, 10) : -1
  selectedElement.value = msgEl
  captureHighlightRects(sel)
}

/** Dismiss selection when clicking blank space or user messages inside the chat area. */
function handleChatAreaClick(e: MouseEvent): void {
  if (!selectedText.value) return
  const target = e.target as HTMLElement

  // Walk up to check if click is inside a selectable area — if so, don't dismiss
  let node: HTMLElement | null = target
  while (node && node !== messagesContainer.value) {
    if (node.dataset.msgIdx !== undefined && node.classList.contains('chat-assistant')) return
    if (node.classList.contains('tool-group')) return
    if (node.classList.contains('system-event')) return
    node = node.parentElement
  }

  clearSelection()
}

function clearSelection(): void {
  selectedText.value = ''
  selectedMsgIndex.value = -1
  selectedElement.value = null
  highlightRects.value = []
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '...'
}

function scrollToSelection(): void {
  const container = messagesContainer.value
  if (!container) return
  // Scroll to the first highlight rect for precision
  if (highlightRects.value.length > 0) {
    const firstRect = highlightRects.value[0]
    const targetTop = firstRect.top - container.clientHeight / 3
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
    return
  }
  if (selectedElement.value) {
    selectedElement.value.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function buildSelectionMessage(userQuestion: string): string {
  const quote = selectedText.value
  if (!quote) return userQuestion
  const quotedLines = quote.split('\n').map(l => `> ${l}`).join('\n')
  return `${quotedLines}\n\n${userQuestion}`
}

async function askInline(): Promise<void> {
  const question = inputText.value.trim()
  if (!question || streaming.value) return
  const content = buildSelectionMessage(question)
  await sendMessage(content)
}

async function askInFork(): Promise<void> {
  const question = inputText.value.trim()
  if (!question || streaming.value) return

  const quote = selectedText.value
  const quotedLines = quote ? quote.split('\n').map(l => `> ${l}`).join('\n') : ''
  const content = [
    '[Branched conversation — the user wants to explore a specific part of the previous discussion in a separate thread.]',
    '',
    quotedLines,
    '',
    question,
  ].filter(Boolean).join('\n')

  const parentSessionId = activeSessionId.value
  const context = [...contextItems.value]
  collapsedSessions.delete(parentSessionId)
  resetConversation()
  contextItems.value = context
  // Sending establishes parent lineage; fetching the empty child first would not.
  activeSessionId.value = `web:chat-${crypto.randomUUID()}`
  await sendMessage(content, { parentSessionId })
}

function handleResize(): void {
  if (highlightRects.value.length > 0) clearSelection()
}

function handleTypingFocus(e: KeyboardEvent): void {
  if (activePanel.value !== 'conversation' || !isComposerTypingKey(e)) return
  const input = chatInput.value
  if (!input) return
  const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [role="slider"], [role="listbox"]'
  const editing = [e.target, document.activeElement].some(target => target instanceof Element && !!target.closest(editable))
  const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], .project-dialog-backdrop, .project-menu-backdrop, .composer-popover-backdrop'))
    .some(element => element.getClientRects().length > 0)
  if (!canRedirectComposerKey(e, {
    available: route.name === 'chat' && (!activeSessionId.value || isDirectChat.value) && !viewingPhysicalId.value
      && !input.disabled && !input.readOnly && !preparingSend.value && !pickingContext.value,
    editing,
    overlayOpen,
  })) return

  e.preventDefault()
  input.focus({ preventScroll: true })
  // Insert the triggering character once; subsequent keys use normal textarea input.
  input.setRangeText(e.key, input.selectionStart, input.selectionEnd, 'end')
  inputText.value = input.value
  autoResize()
}

document.addEventListener('mouseup', handleTextSelection)
document.addEventListener('keydown', handleTypingFocus)
window.addEventListener('resize', handleResize)
const onGlobalConfigChanged = () => { void loadGlobalConfig() }
window.addEventListener('shadow:config-changed', onGlobalConfigChanged)
onUnmounted(() => {
  sessionSelectionGeneration++
  sendRequest?.abort()
  historyRequest?.abort()
  sessionListRequest?.abort()
  document.removeEventListener('mouseup', handleTextSelection)
  document.removeEventListener('keydown', handleTypingFocus)
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('shadow:config-changed', onGlobalConfigChanged)
  stopStagePolling()
  disconnectEventStream()
})

onMounted(async () => {
  await Promise.all([loadSessionList(), loadGlobalConfig()])
  startStagePolling()
  // Restore session from route param
  const routeSessionId = route.params.sessionId as string | undefined
  if (routeSessionId && allSessions.value.some(s => s.sessionId === routeSessionId)) {
    selectSession(routeSessionId)
  }
})
const canResend = computed(() => {
  if (streaming.value) return false
  if (messages.value.length === 0) return false
  const lastMsg = messages.value[messages.value.length - 1]
  return lastMsg.role === 'user'
})
const historyMarkers = computed(() => userMessageMarkers(messages.value))

function resendLastMessage() {
  const lastUserMsg = [...messages.value].reverse().find(m => m.role === 'user')
  sendMessage(lastUserMsg?.content, { retry: true })
}
</script>

<style scoped>
.chat-workspace {
  position: relative;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.conversation-tabs { display: flex; flex-shrink: 0; gap: 24px; padding: 0 24px; border-bottom: 1px solid var(--c-border); }
.conversation-tabs button { display: inline-flex; align-items: center; gap: 6px; position: relative; padding: 13px 0; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.conversation-tabs button.active { color: var(--c-text); font-weight: 550; }
.conversation-tabs button.active::after { position: absolute; content: ''; height: 2px; inset: auto 0 -1px; background: var(--c-blue); border-radius: var(--radius-sm); }
.conversation-tabs button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.chat-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.chat-panel.is-draft { justify-content: center; overflow-y: auto; padding: 40px 0 80px; box-sizing: border-box; }
.draft-heading { flex-shrink: 0; box-sizing: border-box; width: min(100%, 720px); padding: 0 24px; margin: 0 auto 30px; text-align: center; color: var(--c-text); }
.draft-mark { width: 64px; height: 64px; margin: 0 auto 22px; color: var(--c-text-secondary); }
.draft-mark svg { width: 100%; height: 100%; }
.draft-heading h1 { margin: 0 0 10px; font-size: clamp(19px, 2vw, 26px); font-weight: 500; letter-spacing: -.025em; }
.draft-heading p { margin: 0; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
.draft-project { display: inline-flex; align-items: center; gap: 16px; box-sizing: border-box; max-width: 100%; margin-top: 20px; padding: 16px 22px; border: 1px solid color-mix(in srgb, var(--c-blue) 40%, var(--c-border)); border-radius: var(--radius-surface); background: color-mix(in srgb, var(--c-blue) 8%, var(--c-bg-card)); text-align: left; }
.draft-folder-icon { flex: 0 0 34px; width: 34px; height: 34px; color: var(--c-blue); }
.draft-project-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.draft-project-label { color: var(--c-blue); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.draft-project strong { color: var(--c-text); font-size: 24px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.draft-project-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 12px; }
.draft-heading .draft-scratch { margin-top: 14px; }
.chat-header { flex-shrink: 0; gap: 10px; }
.chat-session-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; }
.chat-heading-copy { min-width: 0; overflow-wrap: anywhere; }
.chat-header > button { flex-shrink: 0; }
.chat-history { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
.chat-messages { min-height: 0; min-width: 0; padding-right: 56px; overflow-wrap: anywhere; overscroll-behavior: contain; }
.chat-working { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; box-sizing: border-box; width: calc(100% - 40px); max-width: 860px; margin: 8px auto 0; padding: 11px 14px; border: 1px solid color-mix(in srgb, var(--c-blue) 22%, var(--c-border)); border-radius: var(--radius-surface); background: color-mix(in srgb, var(--c-blue) 5%, var(--c-bg-card)); color: var(--c-blue); }
.chat-working.tool { border-color: color-mix(in srgb, var(--c-warning, #d49a35) 28%, var(--c-border)); background: color-mix(in srgb, var(--c-warning, #d49a35) 6%, var(--c-bg-card)); color: var(--c-warning, #d49a35); }
.chat-working-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 12px; }
.working-wave { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; height: 16px; margin-left: auto; }
.working-wave i { width: 3px; height: 13px; border-radius: var(--radius-sm); background: currentColor; animation: working-wave 1.2s ease-in-out infinite; }
.working-wave i:nth-child(2) { animation-delay: .15s; }
.working-wave i:nth-child(3) { animation-delay: .3s; }
@keyframes working-wave { 0%, 100% { transform: scaleY(.35); opacity: .45; } 50% { transform: scaleY(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .working-wave i { animation: none; } }
.chat-composer { flex: 0 0 auto; min-width: 0; width: calc(100% - 40px); max-width: 860px; margin: 12px auto 16px; }
.composer-box { padding: 12px 12px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); transition: border-color .15s ease; }
.composer-box:focus-within { border-color: var(--c-text-secondary); }
.composer-input { display: flex; min-width: 0; }
.composer-input textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 78px; max-height: min(240px, 28dvh); overflow-y: auto; resize: none; padding: 3px 4px 10px; border: 0; outline: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 14px; line-height: 1.6; }
.composer-input textarea::placeholder { color: var(--c-text-secondary); }
.composer-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 4px; min-width: 0; }
.composer-controls { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: calc(100% - 42px); }
.composer-send, .composer-send-actions { margin-left: auto; flex-shrink: 0; }
.composer-send { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-circle); background: var(--c-primary-bg); color: var(--c-text-on-primary); cursor: pointer; }
.composer-send:disabled { opacity: .35; cursor: not-allowed; }
.composer-send:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.composer-send:focus-visible, .context-action:focus-visible, .context-chip button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.composer-send-actions { display: flex; gap: 8px; }
.composer-context { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 10px; }
.context-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 5px 4px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text-secondary); font-size: 12px; }
.context-chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-icon { flex-shrink: 0; width: 17px; height: 17px; }
.context-chip button { flex-shrink: 0; padding: 0 3px; border: 0; background: transparent; color: var(--c-text-secondary); font-size: 17px; cursor: pointer; }
.context-action { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.context-action:hover { background: var(--c-bg-muted); }
.composer-error { margin: 8px 4px; color: var(--c-error); font-size: 12px; overflow-wrap: anywhere; }
.composer-hint { margin-top: 9px; text-align: center; color: var(--c-text-secondary); font-size: 11px; opacity: .65; }
.mobile-sessions-toggle { display: none; }
.mobile-sidebar-backdrop { display: none; }
@media (max-width: 1000px) {
  .chat-workspace { grid-template-columns: 240px minmax(0, 1fr); }
}
@media (max-width: 700px) {
  .chat-workspace { grid-template-columns: minmax(0, 1fr); }
  .sessions-sidebar { display: none; position: absolute; inset: 36px auto 0 0; width: min(280px, 82%); z-index: 12; box-shadow: 8px 0 24px var(--c-shadow-soft); }
  .mobile-sessions-open .sessions-sidebar { display: flex; }
  .mobile-sidebar-backdrop { display: block; position: absolute; inset: 36px 0 0; z-index: 11; border: 0; background: rgb(0 0 0 / 25%); }
  .mobile-sessions-toggle { display: block; position: absolute; top: 6px; left: 8px; z-index: 13; }
  .chat-header { padding-top: 42px; }
  .chat-panel.is-draft { padding: 58px 0 28px; }
  .draft-heading { margin-bottom: 18px; }
  .draft-mark { width: 48px; height: 48px; margin-bottom: 16px; }
  .draft-project { padding: 14px; gap: 12px; }
  .draft-project strong { font-size: 21px; }
  .chat-working { width: calc(100% - 24px); gap: 8px; }
  .chat-working-detail { display: none; }
  .chat-composer { width: calc(100% - 24px); margin-bottom: 12px; }
  .composer-controls { gap: 0; }
}
.retry-row {
  margin-top: 0.5rem;
}

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.btn {
  border: 1px solid var(--c-border);
  background: var(--c-primary-bg);
  color: var(--c-text-on-primary);
  padding: 0.35rem 0.7rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, background 0.15s ease;
}

.btn:hover:not(:disabled) {
  background: var(--c-primary-bg-hover);
  transform: translateY(-1px) scale(1.03);
  box-shadow: 0 4px 12px var(--c-shadow);
}

.btn:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
  box-shadow: none;
  transition-duration: 0.08s;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.25rem 0.5rem;
  font-size: 0.7rem;
}

/* ── System event ─────────────────────────────────────────── */

.system-event {
  align-self: stretch;
  border: 1px solid var(--c-purple-border);
  padding: 0.3rem 0.5rem;
  border-radius: var(--radius-surface);
  background: var(--c-purple-soft);
  font-size: 0.7rem;
  color: var(--c-text-body);
  transition: background 0.1s ease;
}

.system-event:hover {
  background: var(--c-purple-soft-bg);
}

.system-event-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
  user-select: none;
}

.system-event-type {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6rem;
  font-weight: 600;
  color: var(--c-purple);
  letter-spacing: 0.02em;
}

.system-event-source {
  font-size: 0.55rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-radius: var(--radius-sm);
  padding: 0.05em 0.35em;
  background: var(--c-purple-soft-bg);
  color: var(--c-purple);
  white-space: nowrap;
}

.system-event-status {
  font-size: 0.5rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-radius: var(--radius-sm);
  padding: 0.05em 0.35em;
  background: var(--c-bg-muted);
  color: var(--c-text-muted);
}

.system-event-status.completed {
  background: var(--c-success-bg);
  color: var(--c-success);
}

.system-event-status.failed,
.system-event-status.error {
  background: var(--c-error-bg);
  color: var(--c-error);
}

.system-event-toggle {
  flex-shrink: 0;
  font-size: 0.45rem;
  margin-left: auto;
  color: var(--c-text-faint);
}

.system-event-title {
  margin-top: 0.15rem;
  font-size: 0.65rem;
  color: var(--c-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.system-event-body {
  margin-top: 0.25rem;
}

.system-event-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.4rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--c-border);
  margin-bottom: 0.25rem;
}

.system-event-attr {
  display: flex;
  gap: 0.2rem;
  align-items: baseline;
  font-size: 0.55rem;
}

.system-event-attr-key {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 600;
  color: var(--c-text-muted);
}

.system-event-attr-val {
  color: var(--c-text-body);
  word-break: break-all;
}

.system-event-content {
  font-size: 0.7rem;
  line-height: 1.5;
  color: var(--c-text-secondary);
}

.system-event-content :deep(pre) {
  background: var(--c-bg-muted);
  color: var(--c-text);
  border-radius: var(--radius-sm);
  padding: 0.35rem;
  font-size: 0.65rem;
  overflow-x: auto;
  margin: 0.3rem 0;
}

/* ── Chat media ──────────────────────────────────────────── */

/* ── Thinking / reasoning block ───────────────────────────── */

.thinking-block {
  margin-bottom: 0.4rem;
  border: 1px solid color-mix(in srgb, var(--c-warn) 30%, var(--c-border));
  border-radius: var(--radius-control);
  padding: 0.25rem 0.5rem;
  background: var(--c-warning-bg, rgba(245, 158, 11, 0.08));
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  user-select: none;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-warning, #f59e0b);
}

.thinking-icon {
  font-size: 0.7rem;
}

.thinking-label {
  flex: 1;
}

.thinking-toggle {
  font-size: 0.45rem;
  color: var(--c-text-faint);
}

.thinking-content {
  margin-top: 0.3rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--c-text-secondary, var(--c-text-body));
}

.thinking-content :deep(pre) {
  background: var(--c-bg-muted);
  color: var(--c-text);
  border-radius: var(--radius-sm);
  padding: 0.35rem;
  font-size: 0.65rem;
  overflow-x: auto;
  margin: 0.3rem 0;
}

/* ── Chat media ──────────────────────────────────────────── (original) */

.chat-media {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.chat-media-img {
  max-width: 100%;
  max-height: 320px;
  border-radius: var(--radius-control);
  border: 1px solid var(--c-border);
  cursor: pointer;
  transition: opacity 0.12s ease;
}

.chat-media-img:hover {
  opacity: 0.85;
}

.chat-content :deep(.chat-inline-img) {
  max-width: 100%;
  max-height: 320px;
  border-radius: var(--radius-control);
  border: 1px solid var(--c-border);
  cursor: pointer;
  margin: 0.4rem 0;
  display: block;
  object-fit: cover;
  transition: transform 0.2s ease, max-width 0.2s ease, max-height 0.2s ease;
  position: relative;
  z-index: 1;
}

/* ── Chat messages ──────────────────────────────────────────── */

.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.chat-bubble {
  max-width: 80%;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-surface);
  font-size: 0.8rem;
  line-height: 1.5;
  border: 1px solid var(--c-border);
  box-shadow: 0 1px 3px var(--c-shadow-soft);
}

.chat-user {
  align-self: flex-end;
  background: var(--c-bg-muted);
  color: var(--c-text);
  border-color: var(--c-border-soft);
}

.chat-assistant {
  align-self: flex-start;
  background: var(--c-bg-card);
  color: var(--c-text);
}

/* ── Compaction summary ───────────────────────────────────── */

.compaction-summary {
  align-self: stretch;
  border: 1px dashed var(--c-info, #6366f1);
  border-radius: var(--radius-surface);
  overflow: hidden;
  font-size: 0.8rem;
}

.compaction-summary-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  background: var(--c-bg-muted);
}

.compaction-summary-title {
  color: var(--c-info, #6366f1);
  font-weight: 600;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

.compaction-summary-body {
  padding: 0.5rem 0.75rem;
  max-height: 400px;
  overflow-y: auto;
  background: var(--c-bg-muted);
  opacity: 0.85;
}

/* ── Segment navigation bar ──────────────────────────────── */

.segment-nav {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
  background: var(--c-bg-muted);
  border: 1px solid var(--c-border-soft);
  border-radius: var(--radius-surface);
  font-size: 0.75rem;
}

.segment-nav-btn {
  font-size: 0.75rem;
  padding: 0.2rem 0.6rem;
}

.segment-nav-label {
  color: var(--c-info, #6366f1);
  font-weight: 600;
  font-size: 0.75rem;
}

/* ── Selection highlight on assistant bubble ──────────────── */

.chat-assistant.has-selection {
  border-color: var(--c-blue, #3b82f6);
  box-shadow:
    0 0 0 1px var(--c-blue, #3b82f6),
    0 0 12px rgba(59, 130, 246, 0.15),
    0 0 24px rgba(59, 130, 246, 0.06);
  transition: border-color 0.2s ease, box-shadow 0.3s ease;
}

.chat-assistant.has-selection::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.06), transparent 60%);
  pointer-events: none;
  z-index: 0;
}

.chat-assistant.has-selection {
  position: relative;
}

.chat-assistant.has-selection .chat-content ::selection {
  background: rgba(59, 130, 246, 0.25);
  color: inherit;
}

/* ── Inline selection highlight overlay ────────────────────── */

.chat-messages:has(.selection-highlight-overlay) ::selection {
  background: transparent;
}

.selection-highlight-overlay {
  position: absolute;
  pointer-events: none;
  z-index: 1;
  background: rgba(250, 204, 21, 0.4);
  border-radius: var(--radius-sm);
  filter: url(#highlight-rough);
  animation: hl-fade-in 0.25s ease-out;
}

@keyframes hl-fade-in {
  from {
    background: rgba(250, 204, 21, 0.65);
  }
}

.chat-sender {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--c-text-secondary);
  margin-bottom: 0.25rem;
  overflow-wrap: anywhere;
}

.chat-content {
  word-break: break-word;
}

.chat-content :deep(> :first-child) {
  margin-top: 0;
}

.chat-content :deep(> :last-child) {
  margin-bottom: 0;
}

.chat-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.65rem;
  margin-top: 0.4rem;
}

.chat-footer .usage-info {
  margin-top: 0;
}

.chat-content :deep(pre) {
  background: var(--c-bg-code);
  color: var(--c-text-on-dark);
  border-radius: var(--radius-control);
  padding: 0.6rem 0.75rem;
  overflow-x: auto;
  font-size: 0.75rem;
  line-height: 1.5;
  margin: 0.4rem 0;
}

.chat-user .chat-content :deep(pre) {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.chat-content :deep(code) {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.8em;
}

.chat-content :deep(:not(pre) > code) {
  background: var(--c-bg-muted);
  padding: 0.1em 0.3em;
  border-radius: var(--radius-sm);
}

.chat-content :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.8rem;
}

/* ── Tool call / result ────────────────────────────────────── */

.tool-group {
  align-self: flex-start;
  max-width: 85%;
  border: 1px solid var(--c-border);
  font-size: 0.75rem;
  background: var(--c-frosted);
  border-radius: var(--radius-surface);
  padding: 0.3rem 0.6rem;
}

.tool-call-label,
.tool-call-header {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.7rem;
  color: var(--c-text-body);
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}

.tool-call-header:hover {
  color: var(--c-text-secondary);
}

.tool-icon {
  flex-shrink: 0;
  font-size: 0.75rem;
}

.tool-name {
  font-weight: 600;
  color: var(--c-text-secondary);
  flex-shrink: 0;
}

.tool-args {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tool-args-summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: var(--c-text-muted);
  font-size: 0.65rem;
}

.tool-call-toggle {
  flex-shrink: 0;
  font-size: 0.5rem;
  margin-left: auto;
  color: var(--c-text-faint);
}

.tool-call-detail {
  margin: 0.25rem 0 0;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.65rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-secondary);
  background: var(--c-bg-muted);
  border-radius: var(--radius-control);
  padding: 0.4rem 0.5rem;
  max-height: 300px;
  overflow: auto;
}

/* ── Usage badges ─────────────────────────────────────────── */

.usage-info {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.35rem;
  user-select: none;
}

.usage-badge {
  font-size: 0.55rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  border-radius: var(--radius-sm);
  padding: 0.1em 0.4em;
  background: var(--c-bg-muted);
  color: var(--c-text-secondary, var(--c-text-body));
  white-space: nowrap;
}

.usage-badge.total {
  background: var(--c-bg-muted);
  color: var(--c-text-body);
  font-weight: 600;
}

.usage-delta {
  color: var(--c-text-secondary, var(--c-text-body));
  opacity: 0.7;
  font-weight: 400;
}

.tool-result {
  margin-top: 0.25rem;
  border-radius: var(--radius-control);
  background: var(--c-bg-soft);
  padding: 0.3rem 0.5rem;
  transition: background 0.1s ease;
}

.tool-result:hover {
  background: var(--c-bg-muted);
}

.tool-result-header {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-muted);
  cursor: pointer;
  user-select: none;
}

.tool-result-toggle {
  font-size: 0.5rem;
}

.tool-result-content {
  margin: 0.25rem 0 0;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.65rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-text-secondary);
}

.tool-result.collapsed .tool-result-content {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Selection indicator ──────────────────────────────────── */

.selection-indicator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--c-selection-border);
  border-radius: var(--radius-control);
  background: var(--c-selection-bg);
  font-size: 0.75rem;
}

.selection-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  cursor: pointer;
}

.selection-label {
  font-weight: 600;
  color: var(--c-blue);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.selection-text {
  font-style: italic;
  color: var(--c-text-body);
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selection-dismiss {
  border: none;
  background: transparent;
  color: var(--c-text-faint);
  font-size: 0.9rem;
  line-height: 1;
  padding: 0.1rem 0.2rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.1s ease, background 0.1s ease;
}

.selection-dismiss:hover {
  color: var(--c-text-body);
  background: var(--c-bg-muted);
}

.btn-fork {
  background: var(--c-purple);
  border-color: var(--c-purple);
  font-size: 0.7rem;
}

/* ── Session config badges ───────────────────────────────── */

.session-config-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

.config-badge {
  font-size: 0.55rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  border-radius: var(--radius-sm);
  padding: 0.1em 0.4em;
  white-space: nowrap;
  background: var(--c-bg-muted);
  color: var(--c-text-secondary, var(--c-text-body));
}

.config-badge.model {
  background: var(--c-blue-bg, rgba(59, 130, 246, 0.15));
  color: var(--c-blue, #3b82f6);
}

.config-badge.thinking-on {
  background: var(--c-warning-bg, rgba(245, 158, 11, 0.15));
  color: var(--c-warning, #f59e0b);
}

.config-badge.thinking-off {
  background: var(--c-bg-muted);
  color: var(--c-text-faint);
}

.config-badge.effort {
  background: var(--c-purple-soft, rgba(139, 92, 246, 0.1));
  color: var(--c-purple, #8b5cf6);
}
.resend-bar {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.resend-btn {
  background: transparent;
  border: 1px solid #666;
  color: inherit;
  padding: 6px 16px;
  border-radius: var(--radius-control);
  cursor: pointer;
  font-size: 0.85rem;
}

.resend-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: #aaa;
}
</style>
