<template>
  <div
    ref="paneRoot"
    class="chat-workspace"
    :class="{ 'mobile-sessions-open': mobileSidebarOpen, 'is-draft': !activeSessionId, 'is-embedded': embedded, 'is-managed': managed }"
  >
    <button v-if="!embedded && !managed" class="mobile-sessions-toggle btn btn-sm" :aria-expanded="mobileSidebarOpen" aria-controls="sessions-sidebar" @click="mobileSidebarOpen = !mobileSidebarOpen">Projects</button>
    <button v-if="!embedded && !managed && mobileSidebarOpen" class="mobile-sidebar-backdrop" aria-label="Close projects" @click="mobileSidebarOpen = false" />
    <ProjectsSidebar
      v-if="!embedded && !managed"
      :api-base="apiBase"
      :sessions="allSessions"
      :active-session-id="childSessionId || activeSessionId"
      :draft-project-id="draft.project?.id"
      :remote-folders="installation.mode === 'main'"
      :collapsed="collapsedSessions"
      :stages="displayedSessionStages"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
      @select="requestSession($event); mobileSidebarOpen = false"
      @delete="deleteSession"
      @toggle="toggleCollapse"
      @reload="loadSessionList"
      @scratch="createNewWebChat"
      @remote="createNewWebChat(undefined, true, true)"
      @draft="createNewWebChat"
    />

    <FileWorkbench ref="workbench" :api-base="apiBase" :session-id="activeSession?.sessionId ?? ''" :project-id="!activeSessionId ? draft.project?.id : undefined"
      :context-key="fileContextKey" :explorer-enabled="!embedded && (!activeSessionId || !!currentWorkdir)" :remote="remoteConversation"
      :active="visible && route.name === 'chat'" :keyboard-active="keyboardActive" :draft="!activeSessionId"
      :can-quote="canQuoteSelection" :style="{ '--composer-height': `${dockHeight}px` }"
      @quote="quoteSelection" @conversation-visible="conversationDocumentVisible = $event"
      @image-context="handleImageContext" @image-busy="handleImageBusy">
    <template #actions><slot name="pane-actions" /></template>
    <!-- Chat area -->
    <div class="chat-panel" :class="{ 'is-draft': !activeSessionId }">
      <div v-if="!activeSessionId" class="draft-heading">
        <div v-if="!draft.project" class="draft-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M24 5 40 14v20L24 43 8 34V14L24 5Z" /><path d="m24 14 9 5v10l-9 5-9-5V19l9-5Z" /></svg>
        </div>
        <h1>What would you like to work on?</h1>
        <p v-if="organizationName" class="draft-scratch">{{ organizationName }}</p>
        <div v-if="draft.project" class="draft-project" :aria-label="`Working folder: ${draft.project.name}`">
          <svg class="draft-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h6l3 3h9v11H3V6Z" /><path d="M3 6V4h6l3 3h9v2" /></svg>
          <div class="draft-project-copy">
            <span class="draft-project-label">{{ draft.project.kind === 'remote' ? `Remote project on ${draftRemote?.nodeName}` : 'New conversation in project folder' }}</span>
            <strong>{{ draft.project.name }}</strong>
            <span class="draft-project-path" :title="draft.project.path">{{ draft.project.path }}</span>
          </div>
        </div>
        <p v-else-if="draftRemote" class="draft-scratch">{{ draftRemote.nodeName }} &middot; {{ draftRemote.displayPath || draftRemote.displayName }}</p>
        <p v-else class="draft-scratch">From scratch &middot; No project folder</p>
      </div>
      <template v-else>
        <div class="conversation-heading-row">
          <button v-if="embedded && executionParent" class="btn btn-sm" aria-label="Back to owning execution" @click="inspectExecution(executionParent.sessionId)">
            <span class="i-lucide-arrow-left w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <SessionHeading :key="activeSessionId" :api-base="apiBase" :session-id="activeSessionId"
            :name="activeSessionName" :organization-name="organizationName" :physical-id="viewingPhysicalId" :revision="detailsRevision"
            :active="visible && route.name === 'chat' && !!activeSession" @workdir="currentWorkdir = $event" />
          <button :id="domId('diagnosis-toggle')" class="diagnosis-toggle" :aria-controls="domId('diagnosis-panel')"
            :aria-pressed="activePanel === 'diagnosis'" :title="activePanel === 'diagnosis' ? 'Back to conversation' : 'Open diagnosis'"
            @click="switchPanel(activePanel === 'diagnosis' ? 'conversation' : 'diagnosis')">
            <span class="i-lucide-activity" aria-hidden="true" />Diagnosis
          </button>
        </div>
        <SessionDiagnosis v-if="diagnosisOpened" v-show="activePanel === 'diagnosis'" :id="domId('diagnosis-panel')" role="region" aria-label="Session diagnosis" :id-prefix="embedded || managed ? paneId : undefined"
          :api-base="apiBase" :session-id="activeSessionId" :physical-id="viewingPhysicalId"
          :active="visible && conversationDocumentVisible && activePanel === 'diagnosis' && route.name === 'chat'" :can-read-trace="installation.uiScopes.includes('audit:read')"
          :working="sessionWorking" :system-prompt="systemPrompt" :compaction-summary="compactionSummary" :tools="tools" />

        <!-- Messages -->
        <div v-show="activePanel === 'conversation'" :id="domId('conversation-panel')" class="chat-history" role="region" aria-label="Conversation history">
        <div ref="messagesContainer" class="flex-1 overflow-y-auto px-4 py-3 chat-messages" style="position: relative;">
          <div v-if="loadingHistory" class="text-sm text-ink/50">Loading history...</div>
          <div v-else-if="messages.length === 0 && !composerError" class="text-sm text-ink/40 select-none">{{ isExecution ? 'No execution trace yet.' : 'No messages yet. Send one below.' }}</div>
          <p v-if="embedded && sessionsError" class="composer-error" role="alert">{{ sessionsError }}</p>
          <p v-if="composerError && (viewingPhysicalId || !isDirectChat)" class="composer-error" role="alert">{{ composerError }}</p>
          <p v-if="readonlyContextError" class="composer-error" role="alert">{{ readonlyContextError }}</p>
          <!-- Segment navigation: view previous (top) -->
          <div v-if="previousPhysicalId && !viewingPhysicalId" class="segment-nav">
            <button class="btn btn-sm segment-nav-btn" @click="viewPreviousSegment"><span class="i-lucide-arrow-left w-3.5 h-3.5" aria-hidden="true" /> View previous session</button>
          </div>
          <details v-if="unlinkedExecutions.length" class="unlinked-executions">
            <summary>Other execution traces · {{ unlinkedExecutions.length }}</summary>
            <p>These executions have no matching tool call in this loaded history.</p>
            <button v-for="execution in unlinkedExecutions" :key="execution.sessionId" class="btn btn-sm"
              @click="inspectExecution(execution.sessionId)">{{ execution.label }} <span class="i-lucide-arrow-up-right" aria-hidden="true" /></button>
          </details>
          <template v-for="(msg, idx) in displayMessages" :key="`${activeSessionId}:${viewingPhysicalId ?? ''}:${idx}`">
            <ExecutionMessage v-if="inlineExecutions.entries.has(idx)" :execution="inlineExecutions.entries.get(idx)!"
              @inspect="inspectExecution" @interact="clearSelection">
              <div v-if="inlineExecutions.entries.get(idx)!.output" class="prose" v-html="renderMarkdown(inlineExecutions.entries.get(idx)!.output!)" />
            </ExecutionMessage>
            <ToolActivityGroup v-else-if="toolActivity.has(idx)" :batch="toolActivity.get(idx)!"
              :running="streaming && !streamContent && toolActivity.get(idx)!.end === displayMessages.length"
              @interact="clearSelection" />
            <template v-else-if="msg.event === 'tool_call' || msg.event === 'tool_result'" />
            <!-- System event (not a user message) -->
            <ConversationEvent v-else-if="msg.role === 'user' && msg.isSystemEvent && msg.eventMeta"
              :meta="msg.eventMeta" :timestamp="msg.timestamp" :source="sourceForEvent(msg.eventMeta)"
              @inspect="inspectExecution" @interact="clearSelection">
              <div v-if="msg.content" class="prose" v-html="renderMarkdown(msg.content)" />
            </ConversationEvent>
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
              ]"
              role="article"
              :aria-label="msg.role === 'user' ? (msg.senderName ? `Message from ${msg.senderName}` : 'User message') : 'Assistant message'"
            >
              <div v-if="msg.role === 'user' && msg.senderName" class="chat-sender">{{ msg.senderName }}</div>
              <!-- Reasoning / thinking content (collapsible) -->
              <div v-if="msg.reasoningContent || msg.reasoningText" class="thinking-block">
                <div class="thinking-header" @click="toggleThinking(idx)">
                  <span class="thinking-icon i-lucide-brain w-4 h-4" aria-hidden="true" />
                  <span class="thinking-label">Thinking</span>
                  <span class="thinking-toggle w-3 h-3" :class="expandedThinking.has(idx) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" />
                </div>
                <div v-if="expandedThinking.has(idx)" class="thinking-content prose" v-html="renderMarkdown(msg.reasoningContent || msg.reasoningText || '')" />
              </div>
              <div class="chat-content prose" v-html="renderMarkdown(msg.content)" />
              <div
                v-if="isDirectChat && isErrorMessage(msg) && idx === messages.length - 1 && !requestBusy && !currentRecovery"
                class="retry-row"
              >
                <button class="btn btn-sm retry-btn" @click="retryLastRequest"><span class="i-lucide-rotate-ccw w-3.5 h-3.5" aria-hidden="true" /> Retry</button>
              </div>
              <div v-if="msg.media?.length" class="chat-media">
                <template v-for="(src, mIdx) in msg.media" :key="mIdx">
                  <img
                    v-if="isImageMedia(src) && resolveMediaUrl(src)"
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
          <!-- Streaming response -->
          <div v-if="streaming && streamContent" class="chat-bubble chat-assistant" role="article" aria-label="Assistant message">
            <div class="chat-content">
              <span>{{ streamContent }}</span>
            </div>
            <div class="chat-footer"><MessageTimestamp :timestamp="streamTimestamp" /></div>
          </div>
          <!-- Segment navigation: back to current + view older (bottom) -->
          <div v-if="viewingPhysicalId" class="segment-nav">
            <button class="btn btn-sm segment-nav-btn" @click="goBackToCurrentSegment">Back to current <span class="i-lucide-arrow-right w-3.5 h-3.5" aria-hidden="true" /></button>
            <span class="segment-nav-label">Viewing previous session</span>
            <button v-if="previousPhysicalId" class="btn btn-sm segment-nav-btn" @click="viewPreviousSegment"><span class="i-lucide-arrow-left w-3.5 h-3.5" aria-hidden="true" /> View older session</button>
          </div>
        </div>
        <MessageHistoryRail :entries="historyMarkers" :container="messagesContainer" :active="visible && conversationDocumentVisible && activePanel === 'conversation' && route.name === 'chat'" />
        </div>
      </template>
    </div>
    <template #composer>
      <div ref="composerDock" v-show="composerVisible" class="conversation-dock" :class="{ 'in-flow': !activeSessionId && conversationDocumentVisible }">
        <div v-if="isExecution && !viewingPhysicalId" class="chat-working execution-summary" role="status" aria-live="polite">
          <SessionActivity :stage="sessionStage" />
          <span class="chat-working-detail">{{ isCall ? 'Call · inherited context · blocking' : 'Task · fresh context · async' }} · Read-only trace</span>
        </div>
        <div v-else-if="sessionWorking && !viewingPhysicalId" class="chat-working" :class="sessionStage" role="status" aria-live="polite">
          <SessionActivity :stage="sessionStage" />
          <span v-if="!isWaitingStage(sessionStage)" class="chat-working-detail">{{ sessionStage === 'tool' ? (streamingToolCallData?.name || 'Running a tool call') : 'The agent is working on your request' }}</span>
          <span v-if="!isWaitingStage(sessionStage)" class="working-wave" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <YieldQuestion v-if="!isCall" :api-base="apiBase" :session-id="activeSessionId"
          :active="visible && composerVisible && !viewingPhysicalId && route.name === 'chat'"
          :stage="sessionStage" :can-answer="installation.uiScopes.includes('chat:write')" @cancelled="handleYieldCancelled" />

        <!-- Input (direct-chat only) -->
        <div v-if="(!activeSessionId || isDirectChat) && !viewingPhysicalId" class="chat-composer">
          <div v-if="currentRecovery && !requestBusy" class="resume-bar" role="status">
            <div>
              <strong>{{ currentRecovery.reason === 'stopped' ? 'Request stopped' : currentRecovery.reason === 'failed' ? 'Request failed' : 'Request interrupted' }}</strong>
              <p>Continue from saved history, without resending your message. Completed operations are retained; uncertain tool outcomes must be checked before repeating them.</p>
            </div>
            <button class="resume-button" aria-label="Resume interrupted request"
              :disabled="!installation.uiScopes.includes('chat:write') || savingSettings || pickingContext"
              @click="resumeCurrentRequest()">
              <span class="i-lucide-play w-4 h-4" aria-hidden="true" /> Continue
            </button>
          </div>
          <div v-if="canResend" class="resend-bar">
            <button class="resend-btn" @click="resendLastMessage()"><span class="i-lucide-rotate-ccw w-3.5 h-3.5" aria-hidden="true" /> Resend last message</button>
          </div>
          <div class="composer-box" :class="{ 'image-drop-target': imageDropTarget }"
            @dragover="handleImageDragOver" @dragleave="handleImageDragLeave" @drop="handleImageDrop">
          <input ref="attachmentInput" class="composer-file-input" type="file" multiple @change="handleAttachmentInput">
          <div v-if="pendingAttachments.length" class="composer-context composer-attachments" aria-label="Attached files">
            <span v-for="attachment in pendingAttachments" :key="attachment.key" class="context-chip attachment-chip" :class="{ 'attachment-reference': attachment.sourceKey }" :title="attachment.source?.path ?? attachment.file.name">
              <img v-if="attachment.previewUrl" :src="attachment.previewUrl" class="attachment-thumb" :alt="attachment.file.name">
              <span v-else class="context-icon i-lucide-paperclip" aria-hidden="true" />
              <span class="attachment-caption"><span>{{ attachment.file.name }}</span><span v-if="attachment.sourceKey" class="attachment-reference-label">Image reference</span><span v-if="attachment.source" class="attachment-source-path">{{ attachment.source.path }}</span></span>
              <button :disabled="streaming || preparingSend" :aria-label="`Remove ${attachment.file.name}`" @click="removePendingAttachment(attachment.key)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button>
            </span>
          </div>
          <div v-if="contextItems.length" class="composer-context" aria-label="Attached context">
            <span v-for="(item, index) in contextItems" :key="`${item.kind}:${item.path}`" class="context-chip" :title="item.path">
              <span class="context-icon" :class="item.kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file'" aria-hidden="true" />
              <span>{{ chatContextName(item.path) }}</span>
              <button :disabled="streaming || preparingSend" :aria-label="`Remove ${chatContextName(item.path)}`" @click="contextItems.splice(index, 1)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button>
            </span>
          </div>
          <div class="composer-input">
            <textarea
              ref="chatInput"
              v-model="inputText"
              :placeholder="remoteConversation ? 'Ask anything about this remote workspace...' : 'Ask anything, or add files and folders for context...'"
              aria-label="Message"
              rows="3"
              :disabled="requestBusy"
              @keydown="handleKeyDown"
              @input="autoResize"
              @paste="handleComposerPaste"
            />
          </div>
          <div class="composer-toolbar">
            <div class="composer-controls">
              <ComposerPopover label="Add attachments or context" :title="composerPopoverTitle" :disabled="!canOpenComposerPopover || pickingContext || streaming || preparingSend || awaitingCall" :width="220">
                <template #trigger><span class="i-lucide-plus w-5 h-5" aria-hidden="true" /></template>
                <template #default="{ close }">
                  <button class="context-action" @click="close(); canPickContext ? pickContext('file') : openAttachmentPicker()">
                    <span class="context-icon i-lucide-file-plus" aria-hidden="true" />
                    Add file
                  </button>
                  <button class="context-action" :disabled="!canPickContext" @click="close(); pickContext('folder')">
                    <span class="context-icon i-lucide-folder-plus" aria-hidden="true" />
                    Add folder
                  </button>
                  <button v-if="canPickContext" class="context-action" @click="close(); openAttachmentPicker()">
                    <span class="context-icon i-lucide-image-plus" aria-hidden="true" />
                    Upload image / file
                  </button>
                </template>
              </ComposerPopover>
              <ModelSelector :settings="reasoningSettings" :settings-disabled="requestBusy || pickingContext" :busy="savingSettings" @change-settings="changeReasoningSettings" />
              <ExecutionLocationSelector v-if="!activeSessionId && installation.mode === 'main'" ref="executionLocationSelector"
                :api-base="apiBase" :selected="draftRemote" :local-label="draftProject?.name"
                :disabled="preparingSend || pickingContext || savingSettings" @select="selectExecutionLocation" />
            </div>
            <div class="composer-submit">
            <span class="composer-hint" role="status">{{ currentRequest?.state.stopping ? 'Stopping current request; waiting for Main...' : preparingSend ? 'Starting conversation...' : requestBusy ? 'The current request is running' : imageEditsBusy.size ? 'Preparing marked image...' : imageDropTarget ? 'Drop image to attach' : savingSettings ? 'Saving conversation settings...' : pickingContext ? 'Choosing context...' : 'Enter to send · Shift+Enter for a new line' }}</span>
            <button
              v-if="requestBusy"
              class="composer-stop"
              :disabled="currentRequest?.state.stopping || !installation.uiScopes.includes('chat:write')"
              :aria-busy="currentRequest?.state.stopping || undefined"
              aria-label="Stop current request"
              title="Stop current request; queued messages are kept"
              @click="stopCurrentRequest()"
            >
              <span class="i-lucide-square w-3.5 h-3.5" aria-hidden="true" />
              {{ currentRequest?.state.stopping ? 'Stopping...' : 'Stop request' }}
            </button>
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
          </div>
          <p v-if="composerError" class="composer-error" role="alert">{{ composerError }}</p>
          <p v-if="currentRequest?.state.error" class="composer-error" role="alert">{{ currentRequest.state.error }}</p>
          <p v-if="stageError && requestBusy" class="composer-error" role="status">{{ stageError }}</p>
          <p v-if="settingsError" class="composer-error" role="alert">{{ settingsError }}</p>
          <p v-if="remoteConversation" class="remote-execution-note" role="status">Files and commands run on the selected device. Local file attachments are not transferred to that device.</p>
        </div>
      </div>
    </template>
    </FileWorkbench>
    <SelectionMenu ref="selectionMenu" :container="messagesContainer"
      :active="visible && keyboardActive && conversationDocumentVisible && activePanel === 'conversation' && route.name === 'chat'"
      :can-quote="canQuoteSelection" @quote="quoteSelection" />
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, shallowReactive, reactive, computed, nextTick, onMounted, onUnmounted, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import katex from 'katex'
import { buildMediaUrl } from '../media-url.ts'
import SessionDiagnosis from './SessionDiagnosis.vue'
import type { ToolDef } from './ToolsCard.vue'
import ModelSelector from './ModelSelector.vue'
import ComposerPopover from './ComposerPopover.vue'
import MessageHistoryRail from './MessageHistoryRail.vue'
import FileWorkbench from './files/FileWorkbench.vue'
import SelectionMenu from './SelectionMenu.vue'
import { insertQuote } from '../selection-actions.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import SessionActivity from './SessionActivity.vue'
import YieldQuestion from './YieldQuestion.vue'
import ExecutionMessage from './ExecutionMessage.vue'
import ConversationEvent from './ConversationEvent.vue'
import { inlineExecutionMessages } from '../execution-messages.ts'
import { parseChatEvent, eventSourceSession, type ChatEventMeta } from '../chat-events.ts'
import { executionStages, isOneShot, ownedExecutions } from '../subagent-executions.ts'
import ProjectsSidebar from './ProjectsSidebar.vue'
import { apiUrl } from '../api-url.ts'
import { provideModelSelection, useModelSelection } from '../model-selection.ts'
import { parseSessionGraph, type SidebarSession } from '../projects-sidebar.ts'
import { createProjectsClient, type ProjectRecord } from '../projects-client.ts'
import { addChatContext, chatContextName, composeChatMessage, type ChatContextItem } from '../chat-draft.ts'
import ExecutionLocationSelector from './ExecutionLocationSelector.vue'
import { createProjectChatDraft, createRemoteChatDraft, type RemoteConversationTarget } from '../remote-conversations.ts'
import type { SessionDetails } from '../session-details.ts'
import { appendChatAttachments, canSendChatMessage, clipboardImageFiles, composeImageReferenceMessage, revokeChatAttachmentPreviews, updateImageAttachment, uploadChatAttachments, type PendingChatAttachment } from '../chat-attachments.ts'
import { hasImageReference, readImageReference, type ImageContextBusy, type ImageContextUpdate } from '../image-context.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { userMessageMarkers } from '../message-history.ts'
import { displayedSessionStages as resolveDisplayedStages, isWaitingStage, isWorkingStage, parseSessionStages, parseActiveRequestIds, parseSessionRecoveries, shouldRefreshReadonlyHistory, type SessionStage, type WorkingStage } from '../session-activity.ts'
import type { SessionRecovery } from '../../../src/sessions/session-store.ts'
import { canRedirectComposerKey, isComposerFocusKey } from '../composer-autofocus.ts'
import { groupSenderNames } from '../message-author.ts'
import SessionHeading from './SessionHeading.vue'
import { updateSessionSettings, type ReasoningSettings } from '../session-settings.ts'
import { childConversationTarget } from '../conversation-split.ts'
import ToolActivityGroup from './ToolActivityGroup.vue'
import { groupToolActivity } from '../tool-activity.ts'
import { createChatRequestControl, resumeChatRequest, type ChatRequestControl } from '../chat-request-control.ts'

const route = useRoute()
const router = useRouter()

const marked = new Marked({ breaks: true })
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

const props = withDefaults(defineProps<{
  apiBase: string
  organizationId?: string
  organizationName?: string
  managed?: boolean
  initialProject?: ProjectRecord
  openRemote?: boolean
  embedded?: boolean
  sessionId?: string
  childSessionId?: string
  enableChildPane?: boolean
  keyboardActive?: boolean
  visible?: boolean
}>(), { embedded: false, enableChildPane: false, keyboardActive: true, visible: true })
const emit = defineEmits<{
  'open-child': [target: { primaryId: string; childId: string }]
  'primary-change': [id: string]
  'child-navigation': [id: string]
  deleted: [id: string]
  navigate: [id: string]
  prepared: [id: string]
}>()
const paneId = useId()
const domId = (id: string) => props.embedded || props.managed ? `${paneId}-${id}` : id
const paneRoot = ref<HTMLElement>()
const composerDock = ref<HTMLElement>()
const dockHeight = ref(0)
let dockObserver: ResizeObserver | undefined
let mounted = false
let disposed = false

const installation = useInstallationContext()
const modelSelection = useModelSelection()
const modelOverride = ref('')
const conversationModel = computed(() => modelOverride.value || activeSession.value?.config?.model || modelSelection?.current.value || '')
if (modelSelection) provideModelSelection({
  ...modelSelection, current: conversationModel,
  async select(model) {
    if (!model.trim()) return
    modelOverride.value = model
  },
})
const projectsClient = createProjectsClient(props.apiBase)
const draftProject = shallowRef<ProjectRecord | undefined>(props.initialProject)
const draft = shallowRef<ReturnType<typeof createProjectChatDraft> | ReturnType<typeof createRemoteChatDraft>>(createProjectChatDraft(projectsClient, props.initialProject))
const draftRemote = computed(() => 'remote' in draft.value ? draft.value.remote : undefined)
const currentWorkdir = ref<SessionDetails['workdir']>()
const remoteConversation = computed(() => !activeSessionId.value ? !!draftRemote.value : currentWorkdir.value?.kind === 'remote')
const contextItems = ref<ChatContextItem[]>([])
const pendingAttachments = ref<PendingChatAttachment[]>([])
const imageEditsBusy = ref(new Set<string>())
const imageDropTarget = ref(false)
const composerError = ref('')
const readonlyContextError = ref('')
const preparingSend = ref(false)
const pickingContext = ref(false)
const attachmentInput = ref<HTMLInputElement>()
const canAttachFiles = computed(() => (!activeSessionId.value || !!currentWorkdir.value) && !remoteConversation.value && typeof File === 'function' && typeof FormData === 'function')
const canPickContext = computed(() => (!activeSessionId.value || !!currentWorkdir.value) && !remoteConversation.value && installation.value.mode === 'main' && !!window.shadowDesktop?.chatContext)
const canOpenComposerPopover = computed(() => canAttachFiles.value || canPickContext.value)
const composerPopoverTitle = computed(() =>
  remoteConversation.value ? 'Local attachments are not transferred to remote workspaces'
    : canAttachFiles.value && canPickContext.value
    ? 'Add files or folders'
    : canAttachFiles.value
    ? 'Add files, or use the local Main desktop app to attach folders'
    : 'Folder context requires the local Main desktop app')
const canSend = computed(() => !modelSelection?.loading.value && !modelSelection?.error.value && !isExecution.value && !awaitingCall.value && (!props.embedded || !!activeSession.value) && canSendChatMessage(
  inputText.value,
  contextItems.value.length,
  pendingAttachments.value.length,
) && !requestBusy.value && !pickingContext.value && !savingSettings.value && imageEditsBusy.value.size === 0)
let sendRequest: AbortController | undefined
let historyRequest: AbortController | undefined
const activeSessionId = ref(props.embedded || props.managed ? props.sessionId ?? '' : '')
const requestControls = shallowReactive(new Map<string, ChatRequestControl>())
const draftRequest = shallowRef<ChatRequestControl>()
const currentRequest = computed(() => activeSessionId.value ? requestControls.get(activeSessionId.value) : draftRequest.value)
const fileContextKey = computed(() => JSON.stringify([props.apiBase, activeSessionId.value || (draftRemote.value ? `remote:${draftRemote.value.nodeId}:${draftRemote.value.capabilityId}` : `project:${draft.value.project?.id ?? 'scratch'}`)]))
let sessionSelectionGeneration = 0
const isDirectChat = computed(() => {
  const id = activeSessionId.value
  return id.startsWith('web:chat-') && (!props.embedded || !!activeSession.value) && !isExecution.value
})
const chatInput = ref<HTMLTextAreaElement>()
const messagesContainer = ref<HTMLElement>()
const loadingHistory = ref(false)
const streaming = ref(false)
const streamPhase = ref<WorkingStage>()
const streamContent = ref('')
const streamTimestamp = ref<string>()
const streamingToolCallData = ref<{ name: string; arguments: Record<string, unknown> } | null>(null)
const inputText = ref('')
const mobileSidebarOpen = ref(false)

// ── Session stage polling (batch) ────────────────────────────────────────────
const sessionStages = ref<Record<string, SessionStage>>({})
const activeRequestIds = ref<Record<string, string>>({})
const sessionRecoveries = ref<Record<string, SessionRecovery>>({})
const currentRecovery = computed(() => activeSessionId.value ? sessionRecoveries.value[activeSessionId.value] : undefined)
const stageError = ref('')
const displayedSessionStages = computed(() => executionStages(allSessions.value, resolveDisplayedStages(
  sessionStages.value, activeSessionId.value, streaming.value, streamPhase.value,
)))
const sessionStage = computed<SessionStage | null>(() =>
  activeSessionId.value ? (displayedSessionStages.value[activeSessionId.value] ?? null) : null,
)
const sessionWorking = computed(() => isWorkingStage(sessionStage.value))
const awaitingCall = computed(() => sessionStage.value === 'waiting-for-call')
const requestBusy = computed(() => preparingSend.value || streaming.value || sessionWorking.value || sessionStage.value === 'pending'
  || !!currentRequest.value && currentRequest.value.state.phase !== 'finished')
async function stopCurrentRequest(): Promise<void> {
  if (!installation.value.uiScopes.includes('chat:write') || !requestBusy.value) return
  let control = currentRequest.value
  if ((!control || control.state.phase === 'finished') && activeSessionId.value) {
    control = createChatRequestControl(props.apiBase, () => {}, fetch, activeSessionId.value, activeRequestIds.value[activeSessionId.value])
    requestControls.set(activeSessionId.value, control)
  }
  await control?.stop()
  void pollSessionStages()
}
async function resumeCurrentRequest(): Promise<void> {
  const sessionId = activeSessionId.value
  const recovery = currentRecovery.value
  if (!sessionId || !recovery || requestBusy.value || !isDirectChat.value
    || !installation.value.uiScopes.includes('chat:write') || savingSettings.value || pickingContext.value) return
  const generation = sessionSelectionGeneration
  const control = createChatRequestControl(props.apiBase, () => {})
  requestControls.set(sessionId, control)
  composerError.value = ''
  if (!eventStream) connectEventStream(sessionId.replace('web:', ''))
  try {
    await resumeChatRequest(props.apiBase, sessionId, recovery.id, control)
    if (sessionRecoveries.value[sessionId]?.id === recovery.id) delete sessionRecoveries.value[sessionId]
    if (generation === sessionSelectionGeneration) {
      void loadSessionList()
      void loadCurrentSession()
    }
  } catch (error) {
    if (generation === sessionSelectionGeneration) {
      composerError.value = error instanceof Error ? error.message : 'Could not continue this conversation. Refresh and retry.'
    }
  } finally {
    if (generation === sessionSelectionGeneration) void pollSessionStages()
  }
}
function handleYieldCancelled(sessionId: string): void {
  if (activeSessionId.value !== sessionId) return
  // The yield endpoint has requested a real abort. Keep the reader and busy
  // state until the terminal event or a fresh server activity read confirms it.
  void pollSessionStages()
}
const activeSession = computed(() => allSessions.value.find(session => session.sessionId === activeSessionId.value))
const selectedMode = ref<SidebarSession['mode']>()
const isExecution = computed(() => !!activeSessionId.value && isOneShot({ mode: activeSession.value?.mode ?? selectedMode.value }))
const isCall = computed(() => !!activeSessionId.value && (activeSession.value?.mode ?? selectedMode.value) === 'call')
const executionParent = computed(() => allSessions.value.find(session =>
  session.sessionId === activeSession.value?.parentSessionId && isOneShot(session)))
const activeSessionName = computed(() => {
  const session = activeSession.value
  if (session?.label && session.label !== session.sessionId && session.label !== session.sessionId.replace('web:', '')) return session.label
  return messages.value.find(message => message.role === 'user' && !message.isSystemEvent && !message.isSummary)?.content.trim().split('\n')[0] || 'Conversation'
})
const detailsRevision = ref(0)
const settingsOverride = ref<ReasoningSettings>()
const pendingDraftSettings = ref<ReasoningSettings>()
const reasoningSettings = computed<ReasoningSettings>(() => settingsOverride.value ?? activeSession.value?.config ?? {})
const savingSettings = ref(false)
const settingsError = ref('')
let settingsRequest: AbortController | undefined

async function changeReasoningSettings(patch: ReasoningSettings): Promise<void> {
  if (isExecution.value || awaitingCall.value) return
  if (savingSettings.value || requestBusy.value || pickingContext.value) return
  if ((!('thinking' in patch) || (patch.thinking?.type ?? null) === (reasoningSettings.value.thinking?.type ?? null))
    && (!('reasoningEffort' in patch) || (patch.reasoningEffort ?? null) === (reasoningSettings.value.reasoningEffort ?? null))) return
  settingsError.value = ''
  if (!activeSession.value) {
    settingsOverride.value = { ...reasoningSettings.value, ...patch }
    pendingDraftSettings.value = settingsOverride.value
    return
  }
  const sessionId = activeSessionId.value
  const controller = new AbortController()
  settingsRequest = controller
  savingSettings.value = true
  try {
    const settings = await updateSessionSettings(props.apiBase, sessionId, patch, controller.signal)
    if (controller.signal.aborted) return
    settingsOverride.value = settings
    allSessions.value = allSessions.value.map(session => session.sessionId === sessionId ? {
      ...session, config: { ...session.config, thinking: settings.thinking ?? undefined, reasoningEffort: settings.reasoningEffort ?? undefined },
    } : session)
  } catch (cause) {
    if (!controller.signal.aborted) settingsError.value = cause instanceof Error ? cause.message : 'Could not save conversation settings. Please try again.'
  } finally {
    if (settingsRequest === controller) { settingsRequest = undefined; savingSettings.value = false }
  }
}
let stageInterval: ReturnType<typeof setInterval> | null = null
let stageRequest: AbortController | undefined
let lastReadonlyRefresh = 0

async function pollSessionStages(): Promise<void> {
  if (stageRequest || !props.visible) return
  if (!sessionListRequest && Date.now() - lastGraphRefresh >= 3000) void loadSessionList()
  const controller = new AbortController()
  const observedRequest = currentRequest.value
  const observedActive = observedRequest?.state.phase === 'active'
  const observedSessionId = activeSessionId.value
  stageRequest = controller
  try {
    const res = await fetch(buildUrl('/api/sessions/stages'), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) })
    if (!res.ok) throw new Error('Session activity is unavailable.')
    const snapshot: unknown = await res.json()
    const stages = parseSessionStages(snapshot)
    const identities = parseActiveRequestIds(snapshot)
    const recoveries = parseSessionRecoveries(snapshot)
    if (!controller.signal.aborted) {
      const previous = sessionStages.value[activeSessionId.value]
      sessionStages.value = stages
      activeRequestIds.value = identities
      sessionRecoveries.value = recoveries
      stageError.value = ''
      if (observedActive && observedRequest === currentRequest.value && observedSessionId === activeSessionId.value
        && (stages[observedSessionId] === 'idle' || stages[observedSessionId] === 'inactive')
        && !sendRequest) {
        observedRequest?.finish()
        streaming.value = false
        streamPhase.value = undefined
        if (isDirectChat.value && !historyRequest) void loadCurrentSession()
      }
      const identity = identities[activeSessionId.value]
      const current = currentRequest.value
      if (!sendRequest && identity && isWorkingStage(stages[activeSessionId.value])
        && (!current || current.state.phase === 'finished'
          || current.state.phase === 'active' && current.state.requestId !== identity)) {
        // A different active input confirms the old one ended, even if its
        // terminal SSE was missed. Never forward its pending Stop to this input.
        const error = current?.state.error
        current?.finish()
        const restored = createChatRequestControl(props.apiBase, () => {}, fetch, activeSessionId.value, identity)
        if (error) restored.state.error = error
        requestControls.set(activeSessionId.value, restored)
      }
      if (conversationDocumentVisible.value && activeSessionId.value && activeSession.value && !isDirectChat.value && !viewingPhysicalId.value && activePanel.value === 'conversation' && !historyRequest
        && shouldRefreshReadonlyHistory(stages[activeSessionId.value], previous, Date.now() - lastReadonlyRefresh)) {
        void loadReadonlySession(true)
      }
    }
  } catch {
    if (!controller.signal.aborted) {
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
  activeRequestIds.value = {}
  sessionRecoveries.value = {}
}

// ── Background event stream (live push for cron ticks / self-awake / subagents) ──
// A persistent SSE connection kept open for the active direct chat so messages
// triggered outside a user request (scheduled events, subagent replies) render
// live without a manual page refresh.
let eventStream: EventSource | null = null
let bgStreamState: StreamState = { accumulated: '' }
let requestStreamState: StreamState | undefined

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
      if (payload.event !== 'session_message') streaming.value = true
      if (applyStreamPayload(payload, payload.event === 'session_message' ? requestStreamState ?? bgStreamState : bgStreamState)) {
        streaming.value = false
        if (!sendRequest) currentRequest.value?.finish()
        void loadSessionList()
      }
    } catch {
      composerError.value = 'Could not read a live conversation update. Reopen the conversation to reload its history.'
    }
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
  requestStreamState = undefined
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

type ConversationPanel = 'conversation' | 'diagnosis'
const activePanel = ref<ConversationPanel>('conversation')
const diagnosisOpened = ref(false)
const conversationDocumentVisible = ref(true)
const composerVisible = computed(() => !conversationDocumentVisible.value || activePanel.value === 'conversation')
const canQuoteSelection = computed(() => (!activeSessionId.value || isDirectChat.value) && !viewingPhysicalId.value && !streaming.value && !preparingSend.value && !awaitingCall.value)
function switchPanel(panel: ConversationPanel): void {
  activePanel.value = panel
  if (panel === 'diagnosis') diagnosisOpened.value = true
  else if (activeSession.value && !isDirectChat.value && !viewingPhysicalId.value && !historyRequest) void loadReadonlySession(true)
}
interface ChatMsg {
  role: string
  content: string
  senderName?: string
  timestamp?: string
  event?: string
  toolName?: string
  toolCallId?: string
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
  eventMeta?: ChatEventMeta
  /** True for compaction summary messages — the first message after a session compact. */
  isSummary?: boolean
  /** True when this bubble is a failed-request notice that can be retried. */
  isError?: boolean
}

const messages = ref<ChatMsg[]>([])
const displayMessages = computed(() => messages.value)
const inlineExecutions = computed(() => inlineExecutionMessages(
  displayMessages.value, allSessions.value, activeSessionId.value, sessionStages.value, streaming.value,
))
const unlinkedExecutions = computed(() => {
  const linked = new Set([...inlineExecutions.value.entries.values()].map(execution => execution.sessionId))
  return ownedExecutions(allSessions.value, activeSessionId.value).filter(execution => !linked.has(execution.sessionId))
})
const toolActivity = computed(() => groupToolActivity(displayMessages.value, inlineExecutions.value.excluded))
const allSessions = ref<SidebarSession[]>([])
const sessionsLoading = ref(false)
const sessionsError = ref('')
let sessionListRequest: AbortController | undefined
let lastGraphRefresh = 0
const collapsedSessions = reactive(new Set<string>())
const expandedThinking = reactive(new Set<number>())

// ── Segment navigation state ─────────────────────────────────────────────────
const previousPhysicalId = ref<string | null>(null)
const viewingPhysicalId = ref<string | null>(null)
const physicalIdStack = ref<string[]>([])

// ── Text selection state ──────────────────────────────────────────────────────
const selectionMenu = ref<InstanceType<typeof SelectionMenu>>()
const workbench = ref<InstanceType<typeof FileWorkbench>>()

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = apiUrl(props.apiBase, path)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

function sourceForEvent(meta: ChatEventMeta): SidebarSession | undefined {
  return allSessions.value.find(session => session.sessionId === eventSourceSession(meta))
}

function toggleThinking(idx: number): void {
  clearSelection()
  if (expandedThinking.has(idx)) {
    expandedThinking.delete(idx)
  } else {
    expandedThinking.add(idx)
  }
}

// ── History collapsing (from raw ChatMessage[] to ChatMsg[]) ─────────────────

/** Strip `<sender ... />` and `<event ... />` XML metadata tags from text. */
const META_TAG_RE = /^<(?:sender|event)\s[^>]*\/>\s*/
/** Match `MEDIA:<path-or-url>` lines in assistant content. */
const MEDIA_LINE_RE = /^MEDIA:(\S+)$/gm

interface RawMessage {
  role: string
  timestamp?: string
  content: string | Array<{ type: string; text?: string; image_url?: { url?: string } }> | null
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

function rawMediaContent(msg: RawMessage): string[] {
  if (!Array.isArray(msg.content)) return []
  return msg.content.flatMap(part =>
    part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url
      ? [part.image_url.url]
      : [])
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
      const ev = parseChatEvent(msg)
      const content = rawTextContent(msg, true)
      const media = rawMediaContent(msg)
      if (msg.name === '__compaction_summary__') {
        out.push({ role: 'user', content, isSummary: true })
      } else if (ev) {
        out.push({
          role: 'user',
          ...ev,
          isSystemEvent: true,
        })
      } else {
        const entry: ChatMsg = { role: 'user', content, senderName: senderNames[i], timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : undefined }
        if (media.length > 0) entry.media = media
        out.push(entry)
      }
      i++
      continue
    }

    if (msg.role === 'assistant') {
      while (i < raw.length && (raw[i].role === 'assistant' || raw[i].role === 'tool')) {
        const cur = raw[i]

        if (cur.role === 'assistant') {
          const rawText = rawTextContent(cur)
          const rawMedia = rawMediaContent(cur)
          if (rawText) {
            const { text, media } = extractMedia(rawText)
            const entry: ChatMsg = { role: 'assistant', content: text, timestamp: cur.timestamp }
            if (cur.usage) entry.usage = cur.usage
            if (media.length > 0 || rawMedia.length > 0) entry.media = [...media, ...rawMedia]
            if (cur.reasoning_content) entry.reasoningContent = cur.reasoning_content
            if (cur.reasoning_text) entry.reasoningText = cur.reasoning_text
            out.push(entry)
          } else if (rawMedia.length > 0) {
            const entry: ChatMsg = { role: 'assistant', content: '', timestamp: cur.timestamp, media: rawMedia }
            if (cur.usage) entry.usage = cur.usage
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
            const resultById = new Map<string, typeof toolResults[number]>()
            const consumedResults = new Set<typeof toolResults[number]>()
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
                toolCallId: tc.id,
                toolCall: { name: tc.function.name, arguments: parsedArgs },
              })
              const result = resultById.size ? resultById.get(tc.id) : toolResults[j]
              if (result) {
                consumedResults.add(result)
                const entry: ChatMsg = {
                  role: 'assistant',
                  content: result.content,
                  event: 'tool_result',
                  toolName: result.name,
                  toolCallId: tc.id,
                }
                // Attach usage to the last tool_result when assistant had no text content
                if (cur.usage && !rawText && j === cur.tool_calls.length - 1) {
                  entry.usage = cur.usage
                }
                out.push(entry)
              }
            }
            for (const result of toolResults) {
              if (!consumedResults.has(result)) out.push({
                role: 'assistant', event: 'tool_result', content: result.content,
                toolName: result.name, toolCallId: result.toolCallId,
              })
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

async function loadSessionList(): Promise<void> {
  sessionListRequest?.abort()
  const controller = new AbortController()
  sessionListRequest = controller
  lastGraphRefresh = Date.now()
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    const res = await fetch(buildUrl('/api/sessions/graph'), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!res.ok) throw new Error('Cannot load conversations. Check Main and retry.')
    const data = await res.json()
    if (!controller.signal.aborted) {
      const sessions = parseSessionGraph(data, props.organizationId)
      const selected = sessions.find(session => session.sessionId === activeSessionId.value)
      if (activeSession.value && !selected) composerError.value = 'This conversation or execution is no longer available. Close it and refresh the conversation list.'
      if (selected) selectedMode.value = selected.mode
      allSessions.value = sessions
    }
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

const executionLocationSelector = ref<InstanceType<typeof ExecutionLocationSelector>>()

function createNewWebChat(project?: ProjectRecord, syncRoute = true, openRemotePicker = false): void {
  resetConversation()
  draftProject.value = project
  draft.value = createProjectChatDraft(projectsClient, project)
  activeSessionId.value = ''
  mobileSidebarOpen.value = false
  if (!props.embedded && syncRoute) {
    emit('primary-change', '')
    if (props.managed) emit('navigate', '')
    else void router.replace({ name: 'chat', params: { organizationId: props.organizationId } })
  }
  void nextTick(async () => {
    workbench.value?.showConversation()
    await nextTick()
    autoResize()
    if (props.visible && props.keyboardActive) {
      if (openRemotePicker) await executionLocationSelector.value?.openRemote()
      else chatInput.value?.focus({ preventScroll: true })
    }
  })
}

function selectExecutionLocation(target: RemoteConversationTarget | undefined): void {
  if (preparingSend.value || activeSessionId.value) return
  if (target && (contextItems.value.length || pendingAttachments.value.length)) {
    composerError.value = 'Remove local attachments before selecting a remote workspace. Files are not transferred between devices.'
    return
  }
  composerError.value = ''
  if (!target && draftProject.value?.kind === 'remote') draftProject.value = undefined
  draft.value = target ? createRemoteChatDraft(props.apiBase, target) : createProjectChatDraft(projectsClient, draftProject.value)
}

function clearPendingAttachments(): void {
  revokeChatAttachmentPreviews(pendingAttachments.value)
  pendingAttachments.value = []
  imageEditsBusy.value.clear()
  imageDropTarget.value = false
  if (attachmentInput.value) attachmentInput.value.value = ''
}

function handleImageBusy(update: ImageContextBusy): void {
  if (update.contextKey !== fileContextKey.value || disposed) return
  if (update.busy) imageEditsBusy.value.add(update.sourceKey)
  else imageEditsBusy.value.delete(update.sourceKey)
}

function handleImageContext(update: ImageContextUpdate): void {
  if (update.contextKey !== fileContextKey.value || disposed) return
  if (update.file && (!canQuoteSelection.value || !canAttachFiles.value)) {
    composerError.value = 'This conversation cannot receive an image right now. Retry after the current message finishes.'
    return
  }
  try {
    if (update.file && !update.source) throw new Error('The image source is unavailable. Reopen the image before attaching it.')
    pendingAttachments.value = updateImageAttachment(pendingAttachments.value, update.sourceKey, update.file, { source: update.source })
  } catch (cause) {
    composerError.value = cause instanceof Error ? cause.message : 'Could not attach the marked image. Try again.'
  }
}

function isImageDrop(data: DataTransfer | null): boolean {
  return hasImageReference(data) || !!data && Array.from(data.types).includes('Files')
}

function handleImageDragOver(event: DragEvent): void {
  if (!isImageDrop(event.dataTransfer)) return
  event.preventDefault()
  const allowed = canQuoteSelection.value && canAttachFiles.value
  if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
  imageDropTarget.value = allowed
}

function handleImageDragLeave(event: DragEvent): void {
  if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
  imageDropTarget.value = false
}

function handleImageDrop(event: DragEvent): void {
  if (!isImageDrop(event.dataTransfer)) return
  event.preventDefault()
  event.stopPropagation()
  imageDropTarget.value = false
  if (!canQuoteSelection.value || !canAttachFiles.value) {
    composerError.value = 'This conversation cannot receive an image right now.'
    return
  }
  try {
    const reference = readImageReference(event.dataTransfer)
    if (reference) {
      pendingAttachments.value = updateImageAttachment(pendingAttachments.value, reference.sourceKey, reference.file, { source: reference.source })
    } else {
      const images = clipboardImageFiles(event.dataTransfer)
      if (!images.length) throw new Error('Drop an image file here, or use Add file for other attachments.')
      pendingAttachments.value = appendChatAttachments(pendingAttachments.value, images)
    }
    composerError.value = ''
  } catch (cause) {
    composerError.value = cause instanceof Error ? cause.message : 'Could not attach the image. Drag it again.'
  }
}

function removePendingAttachment(key: string): void {
  const attachment = pendingAttachments.value.find(item => item.key === key)
  if (!attachment) return
  revokeChatAttachmentPreviews([attachment])
  pendingAttachments.value = pendingAttachments.value.filter(item => item.key !== key)
}

function openAttachmentPicker(): void {
  composerError.value = ''
  if (!canAttachFiles.value || !attachmentInput.value) {
    composerError.value = 'File attachments are unavailable.'
    return
  }
  attachmentInput.value.value = ''
  attachmentInput.value.click()
}

function handleAttachmentInput(event: Event): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const files = Array.from(input.files ?? [])
  if (files.length === 0) return
  if (!canAttachFiles.value) {
    input.value = ''
    composerError.value = composerPopoverTitle.value
    return
  }
  pendingAttachments.value = appendChatAttachments(pendingAttachments.value, files)
  input.value = ''
  chatInput.value?.focus({ preventScroll: true })
}

function handleComposerPaste(event: ClipboardEvent): void {
  if (!canQuoteSelection.value) { event.preventDefault(); return }
  if (!canAttachFiles.value) {
    if (clipboardImageFiles(event.clipboardData).length) {
      if (!event.clipboardData?.getData('text/plain')) event.preventDefault()
      composerError.value = 'Local image attachments are not transferred to the selected remote workspace.'
    }
    return
  }
  try {
    const images = clipboardImageFiles(event.clipboardData)
    if (!images.length) return
    // Keep native text paste/undo when the clipboard also contains plain text.
    if (!event.clipboardData?.getData('text/plain')) event.preventDefault()
    pendingAttachments.value = appendChatAttachments(pendingAttachments.value, images)
    composerError.value = ''
  } catch (cause) {
    event.preventDefault()
    composerError.value = cause instanceof Error ? cause.message : 'Could not paste the image. Paste again or use Add file.'
  }
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
    emit('deleted', sessionId)
    if (activeSessionId.value === sessionId) {
      createNewWebChat()
    }
    await loadSessionList()
  } catch {
    sessionsError.value = 'Could not delete this conversation. Check Main and retry.'
  }
}

function resetConversation(): void {
  modelOverride.value = ''
  currentWorkdir.value = undefined
  sessionSelectionGeneration++
  settingsRequest?.abort()
  settingsRequest = undefined
  savingSettings.value = false
  settingsError.value = ''
  settingsOverride.value = undefined
  pendingDraftSettings.value = undefined
  activePanel.value = 'conversation'
  diagnosisOpened.value = false
  if (!(currentRequest.value?.state.phase === 'submitting' && currentRequest.value.state.stopping)) sendRequest?.abort()
  sendRequest = undefined
  draftRequest.value = undefined
  historyRequest?.abort()
  historyRequest = undefined
  loadingHistory.value = false
  preparingSend.value = false
  pickingContext.value = false
  streaming.value = false
  streamPhase.value = undefined
  inputText.value = ''
  clearPendingAttachments()
  contextItems.value = []
  composerError.value = ''
  readonlyContextError.value = ''
  clearSelection()
  disconnectEventStream()
  messages.value = []
  streamContent.value = ''
  streamTimestamp.value = undefined
  streamingToolCallData.value = null
  systemPrompt.value = ''
  tools.value = []
  previousPhysicalId.value = null
  viewingPhysicalId.value = null
  physicalIdStack.value = []
  expandedThinking.clear()
}

function requestSession(sessionId: string): void {
  if (sessionId === activeSessionId.value && !props.childSessionId) return
  if (props.enableChildPane) {
    const target = childConversationTarget(allSessions.value, sessionId, activeSessionId.value)
    if (target) {
      if (!props.managed && target.primaryId !== activeSessionId.value) selectSession(target.primaryId, false)
      emit('open-child', target)
      return
    }
    if (props.childSessionId && sessionId === activeSessionId.value) {
      emit('primary-change', sessionId)
      if (props.managed) emit('navigate', sessionId)
      else void router.replace({ name: 'chat', params: { organizationId: props.organizationId, sessionId } })
      return
    }
  }
  if (props.managed) emit('navigate', sessionId)
  else selectSession(sessionId)
}

function inspectExecution(sessionId: string): void {
  if (props.embedded) emit('child-navigation', sessionId)
  else requestSession(sessionId)
}

function selectSession(sessionId: string, syncRoute = true): void {
  resetConversation()
  activeSessionId.value = sessionId
  selectedMode.value = allSessions.value.find(session => session.sessionId === sessionId)?.mode
  if (!props.embedded && syncRoute) {
    emit('primary-change', sessionId)
    if (props.managed) emit('navigate', sessionId)
    else void router.replace({ name: 'chat', params: { organizationId: props.organizationId, sessionId } })
  }
  void loadSessionList()
  void loadCurrentSession()
}

function restoreSession(sessionId: string): void {
  if (!mounted || props.embedded || activeSessionId.value === sessionId) return
  if (!sessionId) createNewWebChat(undefined, false)
  else if (allSessions.value.some(session => session.sessionId === sessionId)) selectSession(sessionId, false)
}

function focusConversation(): void {
  const target = chatInput.value?.getClientRects().length ? chatInput.value : paneRoot.value?.querySelector<HTMLElement>('.document-tabs [aria-selected="true"]')
  target?.focus({ preventScroll: true })
}
defineExpose({ restoreSession, focusConversation, requestSession, activeSessionId, allSessions })

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

async function loadReadonlySession(background = false): Promise<void> {
  historyRequest?.abort()
  const controller = new AbortController()
  historyRequest = controller
  const sessionId = activeSessionId.value

  // Read-only sessions have no live web input; ensure any event stream is closed.
  disconnectEventStream()
  let followBottom = false
  if (!background) loadingHistory.value = true
  lastReadonlyRefresh = Date.now()
  try {
    // Fetch all history + context in parallel
    const [histRes, ctxRes] = await Promise.all([
      fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`, { shallow: 'true' }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }),
      background ? Promise.resolve(null) : fetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/context`), { signal: controller.signal }),
    ])

    if (!histRes.ok) throw new Error('Could not update this conversation. Reopen it to retry.')
    const histData = await histRes.json()
    if (controller.signal.aborted) return
    const container = messagesContainer.value
    followBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 32
    const rawMessages: RawMessage[] = histData.messages ?? []
    messages.value = collapseHistory(rawMessages)
    previousPhysicalId.value = histData.previousPhysicalId ?? null
    if (!background) {
      viewingPhysicalId.value = null
      physicalIdStack.value = []
    }
    composerError.value = ''

    if (ctxRes && !ctxRes.ok) readonlyContextError.value = 'Could not load execution context. Reopen it to retry.'
    if (ctxRes?.ok) {
      const ctxData = await ctxRes.json()
      if (controller.signal.aborted) return
      readonlyContextError.value = ''
      systemPrompt.value = ctxData.systemPrompt ?? ''
      tools.value = ctxData.tools ?? []
    }
  } catch (cause) {
    if (!controller.signal.aborted) composerError.value = cause instanceof Error ? cause.message : 'Could not update this conversation. Reopen it to retry.'
  } finally {
    if (historyRequest === controller) {
      historyRequest = undefined
      loadingHistory.value = false
      if (!background || followBottom) scrollToBottom()
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
    void sendMessage()
  }
}

/** Streaming accumulator state shared between the active request reader and the
 * persistent background event stream. */
interface StreamState { accumulated: string; timestamp?: string }

/** A decoded SSE payload emitted by the web channel. */
interface StreamPayload {
  event?: 'response' | 'tool_call' | 'tool_result' | 'session_message'
  content?: string
  done?: boolean
  media?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  toolCall?: { name: string; arguments: Record<string, unknown> }
  toolCallId?: string
  toolName?: string
  message?: RawMessage
}

/**
 * Apply a single decoded SSE payload to the reactive chat state. Shared by the
 * active `/api/chat/send` reader loop and the persistent `/api/chat/events`
 * background stream so both render identically. Returns true when the payload
 * marks the end of a turn (`done`).
 */
function applyStreamPayload(payload: StreamPayload, state: StreamState): boolean {
  const event = payload.event ?? 'response'
  if (event === 'session_message') {
    const parsed = payload.message && parseChatEvent(payload.message)
    if (!parsed) throw new Error('Invalid live event message')
    const eventId = parsed.eventMeta.attrs['event-id']
    if (eventId && messages.value.some(message => message.eventMeta?.attrs['event-id'] === eventId)) return false
    if (state.accumulated) {
      messages.value.push({ role: 'assistant', content: state.accumulated, timestamp: state.timestamp })
      state.accumulated = ''
      state.timestamp = undefined
      streamContent.value = ''
      streamTimestamp.value = undefined
    }
    messages.value.push({ role: 'user', isSystemEvent: true, ...parsed })
    void loadSessionList()
    scrollToBottom()
    return false
  }
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
    streamingToolCallData.value = payload.toolCall ?? null
    messages.value.push({
      role: 'assistant', event: 'tool_call', content: payload.content ?? '',
      toolCall: payload.toolCall, toolCallId: payload.toolCallId, toolName: payload.toolName,
    })
    scrollToBottom()
  } else if (event === 'tool_result') {
    messages.value.push({
      role: 'assistant', event: 'tool_result', content: payload.content ?? '',
      toolCallId: payload.toolCallId, toolName: payload.toolName,
    })
    if (payload.toolName === 'subagent' || streamingToolCallData.value?.name === 'subagent') void loadSessionList()
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
    detailsRevision.value++
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

async function sendMessage(overrideContent?: string, opts?: {
  parentSessionId?: string
  retry?: boolean
  retryContent?: string
  retryMedia?: string[]
}): Promise<void> {
  if (modelSelection?.loading.value || modelSelection?.error.value) {
    composerError.value = 'Organization models are unavailable. Retry models or update this organization’s model settings.'
    return
  }
  if (isExecution.value) {
    composerError.value = 'Tasks and calls are read-only. Send a message in the owning conversation instead.'
    return
  }
  if (awaitingCall.value) return
  if (props.embedded && !activeSession.value && !opts?.parentSessionId) {
    composerError.value = 'This child conversation is unavailable. Close it and refresh the conversation list.'
    return
  }
  const retry = opts?.retry === true
  const content = retry ? '' : composeChatMessage(overrideContent ?? inputText.value.trim(), contextItems.value)
  const attachments = retry ? [] : [...pendingAttachments.value]
  const model = conversationModel.value
  if (remoteConversation.value && (attachments.length || contextItems.value.length)) {
    composerError.value = 'Remove local attachments before sending to a remote workspace.'
    return
  }
  if ((!content && !retry && attachments.length === 0) || requestBusy.value || pickingContext.value || savingSettings.value || imageEditsBusy.value.size > 0) return
  const generation = sessionSelectionGeneration
  const controller = new AbortController()
  sendRequest = controller
  const priorRecoveryId = currentRecovery.value?.id
  const control = createChatRequestControl(props.apiBase, () => controller.abort())
  if (activeSessionId.value) requestControls.set(activeSessionId.value, control)
  else draftRequest.value = control
  const startingDraft = !activeSessionId.value
  preparingSend.value = startingDraft
  composerError.value = ''
  let accepted = false
  let submitted = false
  let rejected = false
  let completed = false
  let messageAdded = retry

  try {
    const sessionId = activeSessionId.value || await draft.value.prepare(controller.signal)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    requestControls.set(sessionId, control)
    draftRequest.value = undefined
    // Never load context/history for a draft: that endpoint materializes a session.
    historyRequest?.abort()
    historyRequest = undefined
    loadingHistory.value = false
    if (startingDraft && draftRemote.value) currentWorkdir.value = { kind: 'remote', displayPath: draftRemote.value.displayPath ?? null }
    activeSessionId.value = sessionId
    if (props.managed) emit('prepared', sessionId)
    else if (!props.embedded) void router.replace({ name: 'chat', params: { organizationId: props.organizationId, sessionId }, query: startingDraft || opts?.parentSessionId ? {} : route.query })
    preparingSend.value = false
    workbench.value?.showConversation()
    activePanel.value = 'conversation'
    clearSelection()
    streaming.value = true
    streamPhase.value = 'llm'
    streamContent.value = ''
    streamTimestamp.value = undefined
    streamingToolCallData.value = null
    scrollToBottom()

    const chatId = sessionId.replace('web:', '')
    const uploadedAttachments = retry ? [] : await uploadChatAttachments(props.apiBase, chatId, attachments, controller.signal, fetch, opts?.parentSessionId)
    const uploadedMedia = retry ? [...(opts?.retryMedia ?? [])] : uploadedAttachments.map(attachment => attachment.path)
    const messageContent = composeImageReferenceMessage(content, uploadedAttachments)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    const payload: Record<string, unknown> = {
      chatId,
      senderId: 'admin',
    }
    if (retry) {
      payload.retry = true
      // Fallback content used only if the original request never reached the backend.
      if (opts?.retryContent) payload.content = opts.retryContent
      if (uploadedMedia.length > 0) payload.media = uploadedMedia
    } else {
      payload.content = messageContent
      if (uploadedMedia.length > 0) payload.media = uploadedMedia
      const msg: ChatMsg = { role: 'user', content: messageContent, timestamp: new Date().toISOString() }
      if (uploadedMedia.length > 0) msg.media = uploadedMedia
      messages.value.push(msg)
      messageAdded = true
      inputText.value = ''
      clearPendingAttachments()
      contextItems.value = []
      if (chatInput.value) chatInput.value.style.height = 'auto'
    }
    if (opts?.parentSessionId) payload.parentSessionId = opts.parentSessionId
    if (pendingDraftSettings.value || model) payload.config = { ...pendingDraftSettings.value, ...(model ? { model } : {}) }

    control.submitting(sessionId)
    submitted = true
    const res = await fetch(buildUrl('/api/chat/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!res.ok || !res.body) {
      rejected = true
      throw new Error(`Could not send message (${res.status} ${res.statusText}). Retry when Main is available.`)
    }
    accepted = true
    if (sessionRecoveries.value[sessionId]?.id === priorRecoveryId) delete sessionRecoveries.value[sessionId]
    control.admitted(res.headers.get('x-shadow-request-id') ?? undefined)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) {
      controller.abort()
      return
    }
    pendingDraftSettings.value = undefined
    if (!eventStream) connectEventStream(chatId)
    void loadSessionList()

    // Read SSE stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const streamState: StreamState = { accumulated: '' }
    requestStreamState = streamState

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
            completed = true
            control.finish()
            streaming.value = false
            void loadSessionList()
            return
          }
        } catch {
          composerError.value = 'Could not read a live conversation update. Reopen the conversation to reload its history.'
        }
      }
    }

    // Stream ended without explicit done
    flushStreamingTool()
    if (streamState.accumulated) {
      messages.value.push({ role: 'assistant', content: streamState.accumulated, timestamp: streamState.timestamp })
    }
    detailsRevision.value++
  } catch (err) {
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    if (!activeSessionId.value || !messageAdded) {
      composerError.value = err instanceof Error ? err.message : 'Could not start the conversation. Retry.'
    } else {
      messages.value.push({ role: 'assistant', content: `Error: ${err}`, isError: true, timestamp: new Date().toISOString() })
    }
  } finally {
    if (!submitted || rejected || completed) control.finish()
    else if (control.state.phase === 'submitting') control.admitted()
    if (generation === sessionSelectionGeneration) {
      if (sendRequest === controller) {
        sendRequest = undefined
        requestStreamState = undefined
      }
      preparingSend.value = false
      streaming.value = false
      streamPhase.value = undefined
      streamContent.value = ''
      streamTimestamp.value = undefined
      streamingToolCallData.value = null
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
  if (requestBusy.value) return
  while (messages.value.length && isErrorMessage(messages.value[messages.value.length - 1])) {
    messages.value.pop()
  }
  // The message being retried (last user bubble) is sent as a fallback so the
  // request still works if the original send never reached the backend.
  const last = messages.value[messages.value.length - 1]
  const retryContent = last && last.role === 'user' && typeof last.content === 'string'
    ? last.content
    : undefined
  const retryMedia = last && last.role === 'user' ? last.media : undefined
  void sendMessage(undefined, { retry: true, retryContent, retryMedia })
}

/** Tool events are committed immediately so parallel results cannot overwrite each other. */
function flushStreamingTool(): void {
  streamingToolCallData.value = null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scrollToBottom(): void {
  nextTick(() => {
    if (!props.visible || !conversationDocumentVisible.value || activePanel.value !== 'conversation') return
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

function isImageMedia(path: string): boolean {
  if (path.startsWith('data:image/')) return true
  try {
    const ext = new URL(path).pathname.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXT_SET.has(ext)
  } catch {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXT_SET.has(ext)
  }
}

function preprocessFileRefs(text: string): string {
  return text.replace(FILE_REF_RE, (_match, rawPath: string) => {
    const path = rawPath.trim()
    if (isImageMedia(path)) {
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

function clearSelection(): void {
  selectionMenu.value?.dismiss()
}

function quoteSelection(text: string): void {
  const input = chatInput.value
  if (!input || input.disabled || input.readOnly) return
  const quote = insertQuote(inputText.value, text, input.selectionStart, input.selectionEnd)
  inputText.value = quote.text
  void nextTick(() => {
    input.focus({ preventScroll: true })
    input.setSelectionRange(quote.caret, quote.caret)
    autoResize()
  })
}

function handleTypingFocus(e: KeyboardEvent): void {
  if (!props.visible || !conversationDocumentVisible.value || !props.keyboardActive || !paneRoot.value?.getClientRects().length || activePanel.value !== 'conversation' || !isComposerFocusKey(e)) return
  const input = chatInput.value
  if (!input) return
  const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [role="slider"], [role="listbox"], .workbench-explorer'
  const editing = [e.target, document.activeElement].some(target => target instanceof Element && !!target.closest(editable))
  const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], .project-dialog-backdrop, .project-menu-backdrop, .composer-popover-backdrop, .workbench-explorer.drawer'))
    .some(element => element.getClientRects().length > 0
      && (!element.classList.contains('hover-info-popup') || element.contains(document.activeElement)))
  if (!canRedirectComposerKey(e, {
    available: route.name === 'chat' && (!activeSessionId.value || isDirectChat.value) && !viewingPhysicalId.value
      && !input.disabled && !input.readOnly && !preparingSend.value && !pickingContext.value,
    editing,
    overlayOpen,
  })) return

  // Keep native editing/undo and IME text events; event.key is not necessarily committed text.
  input.focus({ preventScroll: true })
}

document.addEventListener('keydown', handleTypingFocus)
const onGlobalConfigChanged = (event: Event) => {
  const organizationId = (event as CustomEvent<{ organizationId?: string }>).detail?.organizationId
  if (!organizationId || organizationId === props.organizationId) detailsRevision.value++
}
window.addEventListener('shadow:config-changed', onGlobalConfigChanged)
onUnmounted(() => {
  disposed = true
  dockObserver?.disconnect()
  settingsRequest?.abort()
  sessionSelectionGeneration++
  if (!(currentRequest.value?.state.phase === 'submitting' && currentRequest.value.state.stopping)) sendRequest?.abort()
  historyRequest?.abort()
  sessionListRequest?.abort()
  document.removeEventListener('keydown', handleTypingFocus)
  window.removeEventListener('shadow:config-changed', onGlobalConfigChanged)
  stopStagePolling()
  disconnectEventStream()
  clearPendingAttachments()
})

onMounted(async () => {
  await loadSessionList()
  if (disposed) return
  mounted = true
  if (props.visible) startStagePolling()
  if (props.embedded) {
    await loadEmbeddedSession(props.sessionId ?? '')
    return
  }
  if (props.managed) {
    if (props.sessionId) {
      selectSession(props.sessionId, false)
    } else if (props.openRemote) {
      await nextTick()
      if (props.visible) await executionLocationSelector.value?.openRemote()
    }
    return
  }
  // Restore session from route param
  const routeSessionId = route.params.sessionId as string | undefined
  if (routeSessionId && allSessions.value.some(s => s.sessionId === routeSessionId)) {
    selectSession(routeSessionId, false)
  }
})
async function loadEmbeddedSession(id: string): Promise<void> {
  if (!allSessions.value.some(session => session.sessionId === id)) await loadSessionList()
  if (disposed || props.sessionId !== id) return
  if (allSessions.value.some(session => session.sessionId === id)) selectSession(id, false)
  else {
    resetConversation()
    activeSessionId.value = id
    composerError.value = 'This child conversation is unavailable. Close it and refresh the conversation list.'
  }
}
watch(() => props.sessionId, id => {
  if (mounted && props.embedded && id && id !== activeSessionId.value) void loadEmbeddedSession(id)
})
watch(() => props.visible, visible => {
  if (!mounted) return
  if (visible) startStagePolling()
  else stopStagePolling()
})
watch(composerDock, element => {
  dockObserver?.disconnect()
  if (!element) return
  dockObserver = new ResizeObserver(() => {
    if (!props.visible || !composerVisible.value || !element.getClientRects().length) return
    const container = messagesContainer.value
    const followBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 32
    dockHeight.value = element.getBoundingClientRect().height
    if (followBottom) void nextTick(() => { if (container) container.scrollTop = container.scrollHeight })
  })
  dockObserver.observe(element)
}, { flush: 'post' })
const canResend = computed(() => {
  if (requestBusy.value || currentRecovery.value) return false
  if (messages.value.length === 0) return false
  const lastMsg = messages.value[messages.value.length - 1]
  return lastMsg.role === 'user'
})
const historyMarkers = computed(() => userMessageMarkers(messages.value))

function resendLastMessage() {
  const lastUserMsg = [...messages.value].reverse().find(m => m.role === 'user')
  void sendMessage(undefined, { retry: true, retryContent: lastUserMsg?.content, retryMedia: lastUserMsg?.media })
}
</script>

<style scoped>
.remote-execution-note { margin: 8px 0 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
.chat-workspace {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.diagnosis-toggle { display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px; min-height: 32px; padding: 6px 8px; margin-right: 12px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.diagnosis-toggle > span { display: block; width: 16px; height: 16px; }
.diagnosis-toggle:hover { background: var(--c-bg-muted); color: var(--c-text); }
.diagnosis-toggle[aria-pressed="true"] { background: var(--c-selection-bg); color: var(--c-blue); }
.diagnosis-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.chat-panel { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
.conversation-heading-row { display: flex; align-items: center; flex-shrink: 0; min-width: 0; }
.conversation-heading-row > :deep(.session-heading) { flex: 1; }
.conversation-dock { position: absolute; inset: auto 0 0; display: flex; flex-direction: column; pointer-events: none; z-index: 3; }
.conversation-dock > * { pointer-events: auto; }
.conversation-dock > .chat-working:last-child { margin-bottom: 16px; }
.conversation-dock.in-flow { position: static; flex: 0 0 auto; }
.chat-workspace.is-embedded { display: flex; width: 100%; }
.chat-workspace.is-managed { grid-template-columns: minmax(0, 1fr); }
.is-embedded :deep(.session-heading) { padding: 4px 8px; }
.chat-panel.is-draft { flex: 0 0 auto; }
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
.chat-history { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
.chat-messages { min-height: 0; min-width: 0; padding-right: 56px; padding-bottom: calc(var(--composer-height, 0px) + 16px); scroll-padding-bottom: calc(var(--composer-height, 0px) + 16px); overflow-wrap: anywhere; overscroll-behavior: contain; }
.chat-working { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; box-sizing: border-box; width: calc(100% - 40px); max-width: 860px; margin: 8px auto 0; padding: 11px 14px; border: 1px solid color-mix(in srgb, var(--c-blue) 22%, var(--c-border)); border-radius: var(--radius-surface); background: color-mix(in srgb, var(--c-blue) 5%, var(--c-bg-card)); color: var(--c-blue); }
.chat-working.tool { border-color: color-mix(in srgb, var(--c-warning, #d49a35) 28%, var(--c-border)); background: color-mix(in srgb, var(--c-warning, #d49a35) 6%, var(--c-bg-card)); color: var(--c-warning, #d49a35); }
.chat-working-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 12px; }
.execution-summary { flex-wrap: wrap; border-color: var(--c-border); background: var(--c-bg-soft); }
.execution-summary .chat-working-detail { display: block; white-space: normal; }
.working-wave { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; height: 16px; margin-left: auto; }
.working-wave i { width: 3px; height: 13px; border-radius: var(--radius-sm); background: currentColor; animation: working-wave 1.2s ease-in-out infinite; }
.working-wave i:nth-child(2) { animation-delay: .15s; }
.working-wave i:nth-child(3) { animation-delay: .3s; }
@keyframes working-wave { 0%, 100% { transform: scaleY(.35); opacity: .45; } 50% { transform: scaleY(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .working-wave i { animation: none; } }
.chat-composer { flex: 0 0 auto; min-width: 0; width: calc(100% - 40px); max-width: 860px; margin: 12px auto 16px; }
.composer-box { padding: 12px 12px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); transition: border-color .15s ease; }
.composer-box:focus-within, .composer-box:has(.composer-control[aria-expanded="true"]) { border-color: var(--c-text-secondary); }
.composer-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.composer-input { display: flex; min-width: 0; }
.composer-input textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 78px; max-height: min(240px, 28dvh); overflow-y: auto; resize: none; padding: 3px 4px 10px; border: 0; outline: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 14px; line-height: 1.6; }
.composer-input textarea::placeholder { color: var(--c-text-secondary); }
.composer-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 4px; min-width: 0; }
.composer-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: calc(100% - 42px); }
.composer-send { margin-left: auto; flex-shrink: 0; }
.composer-box.image-drop-target { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.composer-send { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: var(--c-primary-bg); color: var(--c-text-on-primary); cursor: pointer; }
.composer-send:disabled { opacity: .35; cursor: not-allowed; }
.composer-send:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.composer-stop { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 5px 10px; border: 1px solid var(--c-border); border-radius: 16px; color: var(--c-text); background: var(--c-bg); cursor: pointer; flex-shrink: 0; white-space: nowrap; }
.composer-stop:disabled { opacity: .65; cursor: not-allowed; }
.composer-stop:hover:not(:disabled) { border-color: var(--c-border-hover); }
.composer-stop:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.resume-bar { display: flex; align-items: center; gap: 16px; padding: 12px 14px; margin-bottom: 10px; border: 1px solid var(--c-border-hover); border-radius: 12px; background: var(--c-bg); color: var(--c-text); }
.resume-bar p { margin: 4px 0 0; font-size: 12px; line-height: 1.45; }
.resume-button { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 36px; padding: 8px 12px; border: 0; border-radius: 8px; background: var(--c-primary-bg); color: var(--c-text-on-primary); cursor: pointer; }
.resume-button:disabled { opacity: .5; cursor: not-allowed; }
.resume-button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.composer-send:focus-visible, .context-action:focus-visible, .context-chip button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.composer-context { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 10px; }
.context-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 5px 4px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text-secondary); font-size: 12px; }
.attachment-chip { max-width: min(100%, 240px); }
.attachment-thumb { width: 24px; height: 24px; flex-shrink: 0; border-radius: var(--radius-control); object-fit: cover; }
.attachment-reference { max-width: min(100%, 340px); padding-left: 5px; gap: 10px; }
.attachment-reference .attachment-thumb { width: 72px; height: 48px; object-fit: contain; background: var(--c-bg); }
.attachment-caption { display: flex; flex-direction: column; gap: 4px; }
.attachment-caption > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-reference-label { color: var(--c-text-secondary); font-size: 11px; }
.attachment-source-path { color: var(--c-text-secondary); font-size: 11px; }
.context-chip.attachment-reference button { width: 32px; min-height: 32px; }
.context-chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-icon { flex-shrink: 0; width: 17px; height: 17px; }
.context-chip button { flex-shrink: 0; padding: 0 3px; border: 0; background: transparent; color: var(--c-text-secondary); font-size: 17px; cursor: pointer; }
.context-action { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.context-action:hover { background: var(--c-bg-muted); }
.context-action:disabled { opacity: .5; cursor: not-allowed; }
.composer-error { margin: 8px 4px; color: var(--c-error); font-size: 12px; overflow-wrap: anywhere; }
.composer-submit { display: flex; align-items: center; gap: 10px; margin-left: auto; min-width: 0; max-width: 100%; }
.composer-hint { min-width: 0; text-align: right; color: var(--c-text-secondary); font-size: 11px; line-height: 1.4; }
.mobile-sessions-toggle { display: none; }
.mobile-sidebar-backdrop { display: none; }
@media (max-width: 700px) {
  .chat-workspace { grid-template-columns: minmax(0, 1fr); }
  .chat-workspace:not(.is-embedded):not(.is-managed) > :deep(.file-workbench) { --workbench-top-offset: 36px; padding-top: var(--workbench-top-offset); box-sizing: border-box; }
  .sessions-sidebar { display: none; position: absolute; inset: 36px auto 0 0; width: min(280px, 82%); z-index: 12; box-shadow: 8px 0 24px var(--c-shadow-soft); }
  .mobile-sessions-open .sessions-sidebar { display: flex; }
  .mobile-sidebar-backdrop { display: block; position: absolute; inset: 36px 0 0; z-index: 11; border: 0; background: rgb(0 0 0 / 25%); }
  .mobile-sessions-toggle { display: block; position: absolute; top: 6px; left: 8px; z-index: 13; }
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

.chat-messages > :deep(:is(.chat-assistant, .system-event, .compaction-summary, .tool-activity, .execution-card)) {
  min-width: 0;
  max-width: var(--conversation-item-max-width);
  align-self: flex-start;
}

.system-event, .compaction-summary, .execution-card {
  width: 100%;
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

.unlinked-executions { margin: 8px 0 16px; color: var(--c-text-secondary); font-size: 12px; }
.unlinked-executions summary { cursor: pointer; }
.unlinked-executions button { display: flex; margin: 6px 0; max-width: 100%; text-align: left; overflow-wrap: anywhere; }
.unlinked-executions summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }

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
