<template>
  <div
    ref="paneRoot"
    class="chat-workspace"
    :class="{ 'mobile-sessions-open': mobileSidebarOpen, 'is-draft': !activeSessionId, 'is-embedded': embedded, 'is-managed': managed, 'mobile-chat': mobileLayout }"
  >
    <button v-if="!embedded && !managed" class="mobile-sessions-toggle btn btn-sm" :aria-expanded="mobileSidebarOpen" aria-controls="sessions-sidebar" @click="mobileSidebarOpen = !mobileSidebarOpen">Folders</button>
    <button v-if="!embedded && !managed && mobileSidebarOpen" class="mobile-sidebar-backdrop" aria-label="Close folders" @click="mobileSidebarOpen = false" />
    <FoldersSidebar
      v-if="!embedded && !managed"
      :api-base="apiBase"
      :sessions="allSessions"
      :active-session-id="childSessionId || activeSessionId"
      :draft-folder-id="draft.folder?.id"
      :remote-folders="installation.mode === 'main'"
      :collapsed="collapsedSessions"
      :stages="displayedSessionStages"
      :sessions-loading="sessionsLoading"
      :sessions-error="sessionsError"
      @select="requestSession($event); mobileSidebarOpen = false"
      @delete="deleteSession"
      @toggle="toggleCollapse"
      @reload="loadSessionList"
      @automation="router.push(automationChatLocation(projectId || liveProjectId(apiBase), $event))"
      @scratch="createNewWebChat"
      @remote="createNewWebChat(undefined, true, true)"
      @draft="createNewWebChat"
    />

    <FileWorkbench ref="workbench" :api-base="apiBase" :session-id="activeSessionId" :conversation-title="activeSessionId ? activeSessionName : 'New conversation'" :folder-id="!activeSessionId ? draft.folder?.id : undefined"
      :project-id="projectId" :knowledge-request="knowledgeRequest" :knowledge-enabled="!embedded && installation.uiScopes.includes('main:admin')"
      :context-key="fileContextKey" :explorer-enabled="!embedded && (!activeSessionId || !!currentWorkdir || expectedHome)" :remote="remoteConversation"
      :active="visible && route.name === 'chat'" :keyboard-active="keyboardActive" :draft="!activeSessionId"
      :diagnosis-enabled="!!activeSessionId"
      :can-quote="canQuoteSelection" :style="{ '--composer-height': `${dockHeight}px` }"
      @quote="quoteSelection" @conversation-visible="conversationDocumentVisible = $event"
      @diagnosis-visible="diagnosisVisibilityChanged"
      @knowledge-navigation="knowledgeNavigation"
      @image-context="handleImageContext" @image-busy="handleImageBusy">
    <template #actions><slot name="pane-actions" /></template>
    <template #mobile-actions="{ close }">
      <template v-if="activeSessionId">
        <button @click="close(); showMobileSessionDetails()">Session details</button>
        <button v-if="installation.uiScopes.includes('chat:write')" @click="close(); renameMobileSession()">Rename session</button>
        <button v-if="embedded && executionParent" @click="close(); inspectExecution(executionParent.sessionId)">Back to owning execution</button>
        <details v-if="historyMarkers.length && conversationDocumentVisible && activePanel === 'conversation'" class="mobile-history">
          <summary>Message history</summary>
          <MessageHistoryRail list :entries="historyMarkers" :container="messagesContainer" :active="visible && route.name === 'chat'" @navigate="browseHistory(); close()" />
        </details>
      </template>
    </template>
    <!-- Chat area -->
    <div class="chat-panel" :class="{ 'is-draft': !activeSessionId }">
      <div v-if="!activeSessionId" class="draft-heading">
        <div v-if="!draft.folder" class="draft-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M24 5 40 14v20L24 43 8 34V14L24 5Z" /><path d="m24 14 9 5v10l-9 5-9-5V19l9-5Z" /></svg>
        </div>
        <h1>What would you like to work on?</h1>
        <p v-if="projectName" class="draft-scratch">{{ projectName }}</p>
        <div v-if="draft.folder" class="draft-folder" :aria-label="`Working folder: ${draft.folder.name}`">
          <svg class="draft-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h6l3 3h9v11H3V6Z" /><path d="M3 6V4h6l3 3h9v2" /></svg>
          <div class="draft-folder-copy">
            <span class="draft-folder-label">{{ draft.folder.kind === 'remote' ? `Remote folder on ${draftRemote?.nodeName}` : 'New conversation in folder' }}</span>
            <strong>{{ draft.folder.name }}</strong>
            <span class="draft-folder-path" :title="draft.folder.path">{{ draft.folder.path }}</span>
          </div>
        </div>
        <p v-else-if="draftRemote" class="draft-scratch">{{ draftRemote.nodeName }} &middot; {{ draftRemote.displayPath || draftRemote.displayName }}</p>
        <p v-else class="draft-scratch">From scratch &middot; No folder selected</p>
      </div>
      <template v-else>
        <div v-show="!mobileLayout" class="conversation-heading-row">
          <button v-if="embedded && executionParent" class="btn btn-sm" aria-label="Back to owning execution" @click="inspectExecution(executionParent.sessionId)">
            <span class="i-lucide-arrow-left w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <SessionHeading ref="sessionHeading" :key="activeSessionId" :api-base="apiBase" :session-id="activeSessionId"
            :name="activeSessionName" :project-name="projectName" :topic="activeSession?.topic" :physical-id="viewingPhysicalId" :revision="detailsRevision"
            :can-rename="installation.uiScopes.includes('chat:write')" @renamed="loadSessionList()"
            :active="visible && route.name === 'chat' && !!activeSession" @workdir="currentWorkdir = $event" />
        </div>

        <!-- Messages -->
        <div v-show="activePanel === 'conversation'" :id="domId('conversation-panel')" class="chat-history" role="region" aria-label="Conversation history" :aria-busy="loadingHistory">
        <div ref="messagesContainer" class="chat-messages" @click="openConversationLink" @keydown="previewImageKeydown" @scroll="trackHistoryScroll">
          <div class="chat-message-list">
          <ConversationSkeleton v-if="loadingHistory && messages.length === 0"
            :active="visible && conversationDocumentVisible && activePanel === 'conversation' && route.name === 'chat'" />
          <div v-else-if="!loadingHistory && messages.length === 0 && !composerError" class="conversation-empty">{{ isExecution ? 'No execution trace yet.' : 'No messages yet. Send one below.' }}</div>
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
            <CommandResult v-if="msg.commandReceipt" :receipt="msg.commandReceipt">
              <div class="prose" v-html="renderMarkdown(msg.content)" />
            </CommandResult>
            <ExecutionMessage v-else-if="inlineExecutions.entries.has(idx)" :execution="inlineExecutions.entries.get(idx)!"
              @inspect="inspectExecution" @interact="clearSelection">
              <div v-if="inlineExecutions.entries.get(idx)!.output" class="prose" v-html="renderMarkdown(inlineExecutions.entries.get(idx)!.output!)" />
            </ExecutionMessage>
            <MessageAction v-else-if="messageActions.entries.has(idx)" :message="messageActions.entries.get(idx)!"
              :running="streaming && !viewingPhysicalId" @inspect="inspectExecution" @interact="clearSelection">
              <div class="prose" v-html="renderMarkdown(messageActions.entries.get(idx)!.content)" />
            </MessageAction>
            <ToolActivityGroup v-else-if="toolActivity.has(idx)" :batch="toolActivity.get(idx)!"
              :running="streaming && !streamContent && toolActivity.get(idx)!.end === displayMessages.length"
              @interact="clearSelection" />
            <template v-else-if="msg.event === 'tool_call' || msg.event === 'tool_result'" />
            <!-- System event (not a user message) -->
            <ConversationEvent v-else-if="msg.role === 'user' && msg.isSystemEvent && msg.eventMeta"
              :data-msg-idx="idx"
              :meta="msg.eventMeta" :timestamp="msg.timestamp" :source="sourceForEvent(msg.eventMeta)"
              @inspect="inspectExecution" @interact="clearSelection">
              <div v-if="msg.content" class="prose" v-html="renderMarkdown(msg.content)" />
            </ConversationEvent>
            <!-- Compaction summary (previous conversation context) -->
            <ConversationSummary v-else-if="msg.isSummary" :content="msg.content"
              :render-content="renderMarkdown" @interact="clearSelection" />
            <!-- Normal messages -->
            <div
              v-else
              class="chat-bubble"
              :data-msg-idx="idx"
              :class="[
                msg.sessionSource ? 'chat-user chat-session' : msg.role === 'user' ? 'chat-user' : 'chat-assistant',
              ]"
              role="article"
              :aria-label="msg.sessionSource ? `${sessionMessageTitle(msg.sessionSource)} from ${msg.sessionSource.id || msg.sessionSource.name || 'unknown session'}` : msg.role === 'user' ? (msg.senderName ? `Message from ${msg.senderName}` : 'User message') : 'Assistant message'"
            >
              <component :is="msg.sessionSource.id ? 'button' : 'div'" v-if="msg.sessionSource" class="chat-session-source"
                :type="msg.sessionSource.id ? 'button' : undefined"
                :aria-label="msg.sessionSource.id ? `Open conversation ${msg.sessionSource.id}` : undefined"
                @click="msg.sessionSource.id && inspectExecution(msg.sessionSource.id)">
                <span class="i-lucide-messages-square" aria-hidden="true" />
                <strong>{{ sessionMessageTitle(msg.sessionSource) }}</strong>
                <span>{{ msg.sessionSource.id || msg.sessionSource.name || 'Unknown session' }}</span>
                <span v-if="msg.sessionSource.id" class="i-lucide-arrow-up-right" aria-hidden="true" />
              </component>
              <div v-else-if="msg.role === 'user' && msg.senderName" class="chat-sender">{{ msg.senderName }}</div>
              <!-- Reasoning / thinking content (collapsible) -->
              <div v-if="msg.reasoningContent || msg.reasoningText" class="thinking-block">
                <div class="thinking-header" @click="toggleThinking(idx)">
                  <span class="thinking-icon i-lucide-brain w-4 h-4" aria-hidden="true" />
                  <span class="thinking-label">Thinking</span>
                  <span class="thinking-toggle w-3 h-3" :class="expandedThinking.has(idx) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" />
                </div>
                <div v-if="expandedThinking.has(idx)" class="thinking-content prose" v-html="renderMarkdown(msg.reasoningContent || msg.reasoningText || '')" />
              </div>
              <div v-if="msg.attachmentBody.text" class="chat-content prose" v-html="renderMarkdown(msg.attachmentBody.text)" />
              <div
                v-if="isDirectChat && isErrorMessage(msg) && idx === messages.length - 1 && !requestBusy && !currentRecovery"
                class="retry-row"
              >
                <button class="btn btn-sm retry-btn" @click="retryLastRequest"><span class="i-lucide-rotate-ccw w-3.5 h-3.5" aria-hidden="true" /> Retry</button>
              </div>
              <MessageAttachments :paths="msg.attachmentBody.paths" :api-base="apiBase" :session-id="activeSessionId" @preview="openImagePreview" />
              <div class="chat-footer">
              <div v-if="msg.usage" class="usage-info">
                <span class="usage-badge">{{ msg.usage.promptTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.prompt.toLocaleString() }})</span> prompt</span>
                <span class="usage-badge">{{ msg.usage.completionTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.completion.toLocaleString() }})</span> completion</span>
                <span class="usage-badge total">{{ msg.usage.totalTokens.toLocaleString() }} <span v-if="usageDelta(idx)" class="usage-delta">(+{{ usageDelta(idx)!.total.toLocaleString() }})</span> total</span>
              </div>
              <MessageTimestamp :timestamp="msg.timestamp" />
              </div>
            </div>
            <IoRequestCard v-for="run in ioAfter.get(idx)" :key="run.id" :run="run" :base="apiBase" />
          </template>
          <IoRequestCard v-for="run in ioAfter.get(-1)" :key="run.id" :run="run" :base="apiBase" />
          <details v-if="ioEarlier.length" class="unlinked-executions">
            <summary>Earlier captures · {{ ioEarlier.length }}</summary>
            <IoRequestCard v-for="run in ioEarlier" :key="run.id" :run="run" :base="apiBase" />
          </details>
          <p v-if="ioError" class="composer-error" role="alert">Capture requests: {{ ioError }}</p>
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
        </div>
        <MessageHistoryRail v-if="!mobileLayout" :entries="historyMarkers" :container="messagesContainer" :active="visible && conversationDocumentVisible && activePanel === 'conversation' && route.name === 'chat'" @navigate="browseHistory" />
        </div>
      </template>
    </div>
    <template #diagnosis>
      <SessionDiagnosis v-if="diagnosisOpened" :id="domId('diagnosis-panel')" role="region" aria-label="Session diagnosis" :id-prefix="embedded || managed ? paneId : undefined"
        :api-base="apiBase" :session-id="activeSessionId" :physical-id="viewingPhysicalId"
        :active="visible && activePanel === 'diagnosis' && route.name === 'chat'" :can-read-trace="installation.uiScopes.includes('audit:read')"
        :working="sessionWorking" :system-prompt="systemPrompt" :compaction-summary="compactionSummary" :tools="tools" />
    </template>
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
        <CredentialRequest v-if="activeSessionId === 'web:orchestrator'" :api-base="apiBase"
          :project-id="projectId || liveProjectId(apiBase)" :session-id="activeSessionId"
          :active="visible && composerVisible && !viewingPhysicalId && route.name === 'chat'"
          :stage="sessionStage" :can-submit="installation.uiScopes.includes('main:admin')" />
        <PublicationRequest :api-base="apiBase"
          :project-id="projectId || liveProjectId(apiBase)" :session-id="activeSessionId"
          :active="visible && composerVisible && !viewingPhysicalId && route.name === 'chat'"
          :stage="sessionStage" :can-submit="installation.uiScopes.includes('main:admin')" />
        <AuthoringProbeRequest :api-base="apiBase"
          :project-id="projectId || liveProjectId(apiBase)" :session-id="activeSessionId"
          :active="visible && composerVisible && !viewingPhysicalId && route.name === 'chat'"
          :stage="sessionStage" :can-submit="installation.uiScopes.includes('main:admin')" />

        <!-- Input (direct-chat only) -->
        <div v-if="(!activeSessionId || isDirectChat) && !viewingPhysicalId" class="chat-composer">
          <div v-if="currentRecovery && !requestBusy" class="resume-bar" role="status">
            <div>
              <strong>{{ currentRecovery.reason === 'stopped' ? 'Request stopped' : currentRecovery.reason === 'failed' ? 'Request failed' : 'Request interrupted' }}</strong>
              <p>Resume unfinished tool calls or send their saved results, without adding a message. After a restart, calls without saved results may run again.</p>
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
          <BackgroundTasks :api-base="apiBase" :session-id="activeSessionId" :active="paneActive && !!activeSession" />
          <div class="composer-box" :class="{ 'attachment-drop-target': attachmentDropTarget }"
            @dragover="handleAttachmentDragOver" @dragleave="handleAttachmentDragLeave" @drop="handleAttachmentDrop">
          <SlashCommandMenu ref="slashMenu" :api-base="apiBase" :session-id="activeSessionId || ''"
            :text="inputText" :input="chatInput" :focused="composerFocused"
            :selection-start="composerSelection.start" :selection-end="composerSelection.end"
            :active="paneActive && keyboardActive && composerVisible && !viewingPhysicalId && !submissionBusy && !composerComposing && installation.uiScopes.includes('chat:write') && route.name === 'chat'"
            @complete="completeSlashCommand" />
          <input ref="attachmentInput" class="composer-file-input" type="file" multiple @change="handleAttachmentInput">
          <div v-if="pendingAttachments.length" class="composer-context composer-attachments" aria-label="Attached files">
            <span v-for="attachment in pendingAttachments" :key="attachment.key" class="context-chip attachment-chip" :class="{ 'attachment-reference': attachment.sourceKey }" :title="attachment.source?.path ?? attachment.file.name">
              <button v-if="attachment.previewUrl" type="button" class="attachment-preview" aria-haspopup="dialog" :aria-label="`View image: ${attachment.file.name}`"
                @click="openImagePreview({ src: attachment.previewUrl, name: attachment.file.name, trigger: $event.currentTarget as HTMLButtonElement })">
                <img :src="attachment.previewUrl" class="attachment-thumb" :alt="attachment.file.name">
              </button>
              <span v-else class="context-icon i-lucide-paperclip" aria-hidden="true" />
              <span class="attachment-caption"><span>{{ attachment.file.name }}</span><span v-if="attachment.sourceKey" class="attachment-reference-label">Image reference</span><span v-if="attachment.source" class="attachment-source-path">{{ attachment.source.path }}</span></span>
              <button :disabled="submissionBusy" :aria-label="`Remove ${attachment.file.name}`" @click="removePendingAttachment(attachment.key)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button>
            </span>
          </div>
          <div v-if="contextItems.length" class="composer-context" aria-label="Attached context">
            <span v-for="(item, index) in contextItems" :key="`${item.kind}:${item.path}`" class="context-chip" :title="item.path">
              <span class="context-icon" :class="item.kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file'" aria-hidden="true" />
              <span>{{ chatContextName(item.path) }}</span>
              <button :disabled="submissionBusy" :aria-label="`Remove ${chatContextName(item.path)}`" @click="contextItems.splice(index, 1)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button>
            </span>
          </div>
          <div class="composer-input">
            <textarea
              ref="chatInput"
              v-model="inputText"
              :placeholder="mobileLayout ? 'Message...' : remoteConversation ? 'Ask anything about this remote workspace...' : 'Ask anything, or add files and folders for context...'"
              aria-label="Message"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              :aria-expanded="slashMenu?.open ?? false"
              :aria-controls="slashMenu?.open ? slashMenu.listId : undefined"
              :aria-activedescendant="slashMenu?.activeId"
              :rows="mobileLayout ? 1 : 3"
              :disabled="submissionBusy"
              @keydown="handleKeyDown"
              @input="autoResize(); updateComposerSelection()"
              @focus="composerFocused = true; updateComposerSelection()"
              @blur="composerFocused = false"
              @click="updateComposerSelection"
              @keyup="updateComposerSelection"
              @select="updateComposerSelection"
              @compositionstart="composerComposing = true"
              @compositionend="composerComposing = false; updateComposerSelection()"
              @paste="handleComposerPaste"
            />
          </div>
          <div class="composer-toolbar">
            <div class="composer-controls">
              <ComposerPopover ref="composerOptions" :label="mobileLayout ? 'Message options' : 'Add attachments or context'" :sheet="mobileLayout" :title="composerPopoverTitle" :disabled="mobileLayout ? pickingContext || submissionBusy : !canOpenComposerPopover || pickingContext || submissionBusy" :width="220">
                <template #trigger><span class="i-lucide-plus w-5 h-5" aria-hidden="true" /></template>
                <template #default="{ close }">
                  <button class="context-action" :disabled="!canOpenComposerPopover" @click="close(); canPickContext ? pickContext('file') : openAttachmentPicker()">
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
                  <div v-if="mobileLayout" class="mobile-message-settings">
                    <ModelSelector :settings="reasoningSettings" :settings-disabled="requestBusy || pickingContext" :busy="savingSettings" @change-settings="changeReasoningSettings" />
                    <ExecutionLocationSelector v-if="!activeSessionId && installation.mode === 'main'" ref="executionLocationSelector"
                      :api-base="apiBase" :project-id="projectId || liveProjectId(apiBase)" :selected="draftRemote" :folder="draft.folder"
                      :disabled="preparingSend || pickingContext || savingSettings" @select="selectExecutionLocation" />
                    <button v-if="requestBusy" class="context-action" :disabled="!canSend" @click="close(); sendMessage()">Send guidance to running agent</button>
                  </div>
                </template>
              </ComposerPopover>
              <ModelSelector v-if="!mobileLayout" :settings="reasoningSettings" :settings-disabled="requestBusy || pickingContext" :busy="savingSettings" @change-settings="changeReasoningSettings" />
              <ExecutionLocationSelector v-if="!mobileLayout && !activeSessionId && installation.mode === 'main'" ref="executionLocationSelector"
                :api-base="apiBase" :project-id="projectId || liveProjectId(apiBase)" :selected="draftRemote" :folder="draft.folder"
                :disabled="preparingSend || pickingContext || savingSettings" @select="selectExecutionLocation" />
            </div>
            <div class="composer-submit">
            <span class="composer-hint" role="status">{{ currentRequest?.state.stopping ? 'Stopping current request; waiting for Main...' : preparingSend ? 'Starting conversation...' : submittingMessage ? 'Sending message...' : awaitingCall ? 'Call running · Enter to send guidance' : requestBusy ? 'Enter to send guidance · Shift+Enter for a new line' : imageEditsBusy.size ? 'Preparing marked image...' : attachmentDropTarget ? 'Drop files to attach' : savingSettings ? 'Saving conversation settings...' : pickingContext ? 'Choosing context...' : 'Enter to send · Shift+Enter for a new line' }}</span>
            <button
              v-if="requestBusy"
              class="composer-send composer-stop"
              :disabled="currentRequest?.state.stopping || !installation.uiScopes.includes('chat:write')"
              :aria-busy="currentRequest?.state.stopping || undefined"
              aria-label="Stop current request"
              :title="currentRequest?.state.stopping ? 'Stopping current request; waiting for Main...' : 'Stop current request; queued messages are kept'"
              @click="stopCurrentRequest()"
            >
              <span class="i-lucide-square w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              v-else
              class="composer-send"
              :disabled="!canSend"
              aria-label="Send message"
              :title="submissionBusy ? 'Sending message...' : 'Send message'"
              @click="sendMessage()"
            >
              <span class="i-lucide-arrow-up w-5 h-5" aria-hidden="true" />
            </button>
            </div>
          </div>
          </div>
          <p v-if="mobileLayout && (preparingSend || submittingMessage || imageEditsBusy.size || savingSettings || pickingContext)"
            class="mobile-composer-note" role="status">{{ preparingSend ? 'Starting conversation...' : submittingMessage ? 'Sending...' : imageEditsBusy.size ? 'Preparing image...' : savingSettings ? 'Saving settings...' : 'Choosing context...' }}</p>
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
    <SessionDeleteDialog v-if="deletion" :target="deletion" @close="deletion = undefined" @deleted="sessionsDeleted" />
    <ImageViewer v-if="imagePreview" :image="imagePreview" @close="imagePreview = undefined" />
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, shallowReactive, reactive, computed, inject, provide, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DOMPurify from 'dompurify'
import { useMobileResources } from '../mobile-resources.ts'
const mobileResources = useMobileResources()
import { Marked } from 'marked'
import katex from 'katex'
import MessageAttachments from './MessageAttachments.vue'
import ImageViewer from './ImageViewer.vue'
import { imagePreviewFromEvent, imagePreviewMarkup, type ImagePreview } from '../image-viewer.ts'
import { messageAttachments } from '../message-attachments.ts'
import SessionDiagnosis from './SessionDiagnosis.vue'
import SessionDeleteDialog from './SessionDeleteDialog.vue'
import type { SessionDeletionTarget } from '../session-deletion.ts'
import BackgroundTasks from './BackgroundTasks.vue'
import type { ToolDef } from './ToolsCard.vue'
import ModelSelector from './ModelSelector.vue'
import ComposerPopover from './ComposerPopover.vue'
import SlashCommandMenu from './SlashCommandMenu.vue'
import MessageHistoryRail from './MessageHistoryRail.vue'
import FileWorkbench from './files/FileWorkbench.vue'
import type { KnowledgeTabRequest } from '../file-workbench.ts'
import { createHomeTreeCache, HomeTreeCacheKey } from '../home-tree-cache.ts'
import SelectionMenu from './SelectionMenu.vue'
import { insertQuote } from '../selection-actions.ts'
import MessageTimestamp from './MessageTimestamp.vue'
import SessionActivity from './SessionActivity.vue'
import YieldQuestion from './YieldQuestion.vue'
import CredentialRequest from './CredentialRequest.vue'
import PublicationRequest from './PublicationRequest.vue'
import AuthoringProbeRequest from './AuthoringProbeRequest.vue'
import ExecutionMessage from './ExecutionMessage.vue'
import ConversationSkeleton from './ConversationSkeleton.vue'
import MessageAction from './MessageAction.vue'
import { inlineMessageActions } from '../message-actions.ts'
import ConversationEvent from './ConversationEvent.vue'
import { inlineExecutionMessages } from '../execution-messages.ts'
import { parseChatEvent, parseLiveSessionMessage, eventSourceSession, type ChatEventMeta } from '../chat-events.ts'
import { executionStages, isOneShot, ownedExecutions } from '../subagent-executions.ts'
import FoldersSidebar from './FoldersSidebar.vue'
import { apiUrl } from '../api-url.ts'
import { automationChatLocation } from '../automations.ts'
import { provideModelSelection, useModelSelection } from '../model-selection.ts'
import { isRecord, parseSessionGraph, type SidebarSession } from '../folders-sidebar.ts'
import { liveProjectId, useLiveClientPool } from '../composables/useLiveClient.ts'
import type { LiveSubscription } from '../live-client.ts'
import { createLiveRefresh } from '../live-refresh.ts'
import { createFoldersClient, type FolderRecord } from '../folders-client.ts'
import { addChatContext, chatContextName, composeChatMessage, type ChatContextItem } from '../chat-draft.ts'
import ExecutionLocationSelector from './ExecutionLocationSelector.vue'
import { createFolderChatDraft, createRemoteChatDraft } from '../remote-conversations.ts'
import { createExecutionLocationDraft, type ExecutionLocation } from '../execution-locations.ts'
import type { SessionDetails } from '../session-details.ts'
import { appendChatAttachments, canSendChatMessage, clipboardImageFiles, droppedChatFiles, composeImageReferenceMessage, revokeChatAttachmentPreviews, updateImageAttachment, uploadChatAttachments, type PendingChatAttachment } from '../chat-attachments.ts'
import { hasImageReference, readImageReference, type ImageContextBusy, type ImageContextUpdate } from '../image-context.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { isUserMessage, resendableUserMessage, messageHistoryMarkers } from '../message-history.ts'
import CommandResult from './CommandResult.vue'
import { mergeCommandResults } from '../command-results.ts'
import { isCommandReceipt, type CommandReceipt } from '../../../src/slash-commands/receipt.ts'
import { displayedSessionStages as resolveDisplayedStages, isWaitingStage, isWorkingStage, parseSessionStages, parseActiveRequestIds, parseSessionRecoveries, shouldRefreshReadonlyHistory, type SessionStage, type WorkingStage } from '../session-activity.ts'
import type { SessionRecovery } from '../../../src/sessions/session-store.ts'
import { canRedirectComposerKey, isComposerFocusKey } from '../composer-autofocus.ts'
import { groupSenderNames, parseSessionMessage, sessionMessageTitle, type SessionMessageSource } from '../message-author.ts'
import SessionHeading from './SessionHeading.vue'
import IoRequestCard from './io/IoRequestCard.vue'
import { useIoConversation } from '../io/conversation.ts'
import { updateSessionSettings, type ReasoningSettings, type ConversationSettings } from '../session-settings.ts'
import { draftSettingsKey as createDraftSettingsKey, loadDraftSettings, saveDraftSettings } from '../draft-settings.ts'
import { useConversationNavigation } from '../composables/useConversationNavigation.ts'
import ToolActivityGroup from './ToolActivityGroup.vue'
import ConversationSummary from './ConversationSummary.vue'
import { groupToolActivity } from '../tool-activity.ts'
import { createChatRequestControl, resumeChatRequest, type ChatRequestControl } from '../chat-request-control.ts'
import { conversationLinkSession, isDirectConversation } from '../project-coordination.ts'
import { useMobileChrome } from '../composables/useMobileChrome.ts'

const route = useRoute()
const mobile = useMobileChrome()
const mobileLayout = computed(() => !!mobile?.enabled.value)
const sessionHeading = ref<InstanceType<typeof SessionHeading>>()
async function showMobileSessionDetails() { await nextTick(); await sessionHeading.value?.showDetails() }
async function renameMobileSession() { await nextTick(); await sessionHeading.value?.startRename() }
const router = useRouter()

function openConversationLink(event: MouseEvent) {
  const image = imagePreviewFromEvent(event)
  if (image) { event.preventDefault(); openImagePreview(image); return }
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  const id = anchor && conversationLinkSession(anchor.getAttribute('href') ?? '', props.projectId || liveProjectId(props.apiBase))
  if (!id) return
  event.preventDefault()
  if (props.embedded) void router.push({ name: 'chat', params: { projectId: props.projectId, sessionId: id } })
  else requestSession(id)
}

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
  projectId?: string
  projectName?: string
  managed?: boolean
  initialFolder?: FolderRecord
  openRemote?: boolean
  embedded?: boolean
  sessionId?: string
  childSessionId?: string
  enableChildPane?: boolean
  keyboardActive?: boolean
  visible?: boolean
  knowledgeRequest?: KnowledgeTabRequest
}>(), { embedded: false, enableChildPane: false, keyboardActive: true, visible: true })
const activated = ref(true)
const paneActive = computed(() => props.visible && activated.value)
const livePool = useLiveClientPool()
onActivated(() => { activated.value = true })
onDeactivated(() => { activated.value = false })
const emit = defineEmits<{
  'open-child': [target: { primaryId: string; childId: string }]
  'primary-change': [id: string]
  'child-navigation': [id: string]
  deleted: [id: string]
  navigate: [id: string]
  prepared: [id: string]
  'knowledge-navigation': [active: boolean, entryId?: string]
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
const modelOverride = ref<string>()
const explicitModel = computed(() => modelOverride.value ?? activeSession.value?.config?.model ?? '')
const conversationModel = computed(() => explicitModel.value || modelSelection?.current.value || '')
if (modelSelection) provideModelSelection({
  ...modelSelection, current: conversationModel,
  inherited: modelSelection.current,
  inheriting: computed(() => !explicitModel.value),
  disabled: computed(() => modelSelection.disabled.value || pickingContext.value || isExecution.value || awaitingCall.value),
  select: model => changeConversationSettings({ model: model.trim() || null }),
})
const foldersClient = createFoldersClient(props.apiBase)
const draftFolder = shallowRef<FolderRecord | undefined>(props.initialFolder)
const draft = shallowRef<ReturnType<typeof createFolderChatDraft> | ReturnType<typeof createRemoteChatDraft>>(createFolderChatDraft(foldersClient, props.initialFolder))
const draftRemote = computed(() => 'remote' in draft.value ? draft.value.remote : undefined)
const currentWorkdir = ref<SessionDetails['workdir']>()
const remoteConversation = computed(() => !activeSessionId.value ? !!draftRemote.value : currentWorkdir.value?.kind === 'remote')
const contextItems = ref<ChatContextItem[]>([])
const pendingAttachments = ref<PendingChatAttachment[]>([])
const imageEditsBusy = ref(new Set<string>())
const attachmentDropTarget = ref(false)
const composerError = ref('')
const deletion = ref<SessionDeletionTarget>()
const readonlyContextError = ref('')
const preparingSend = ref(false)
const submittingMessage = ref(false)
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
const canSend = computed(() => !modelSelection?.loading.value && !modelSelection?.error.value && !isExecution.value && (!props.embedded || !!activeSession.value) && canSendChatMessage(
  inputText.value,
  contextItems.value.length,
  pendingAttachments.value.length,
) && !submissionBusy.value && !currentRequest.value?.state.stopping && installation.value.uiScopes.includes('chat:write')
  && !pickingContext.value && !savingSettings.value && imageEditsBusy.value.size === 0)
let sendRequest: AbortController | undefined
let historyRequest: AbortController | undefined
const { activeSessionId, selectedMode, requestSession, selectSession, inspectExecution, restoreSession } = useConversationNavigation({
  props, router, emit, sessions: () => allSessions.value,
  reset: resetConversation,
  refresh: () => { void loadSessionList(); void loadCurrentSession() },
  mounted: () => mounted,
  newDraft: () => createNewWebChat(undefined, false),
})
const homeCache = inject(HomeTreeCacheKey, createHomeTreeCache, true)
provide(HomeTreeCacheKey, homeCache)
const expectedHome = computed(() => homeCache.expectsHome({ apiBase: props.apiBase, sessionId: activeSessionId.value }))
const requestControls = shallowReactive(new Map<string, ChatRequestControl>())
const draftRequest = shallowRef<ChatRequestControl>()
const currentRequest = computed(() => activeSessionId.value ? requestControls.get(activeSessionId.value) : draftRequest.value)
const submissionBusy = computed(() => preparingSend.value || submittingMessage.value
  || currentRequest.value?.state.phase === 'preparing' || currentRequest.value?.state.phase === 'submitting')
const fileContextKey = computed(() => JSON.stringify([props.apiBase, activeSessionId.value || (draftRemote.value ? `remote:${draftRemote.value.nodeId}:${draftRemote.value.capabilityId}` : `folder:${draft.value.folder?.id ?? 'scratch'}`)]))
let sessionSelectionGeneration = 0
const isDirectChat = computed(() => {
  const id = activeSessionId.value
  return isDirectConversation(id) && (!props.embedded || !!activeSession.value) && !isExecution.value
})
const chatInput = ref<HTMLTextAreaElement>()
const messagesContainer = ref<HTMLElement>()
let historyBrowsing = false
let historyLeftBottom = false
const loadingHistory = ref(!!activeSessionId.value)
const streaming = ref(false)
const streamPhase = ref<WorkingStage>()
const streamContent = ref('')
const streamTimestamp = ref<string>()
const streamingToolCallData = ref<{ name: string; arguments: Record<string, unknown> } | null>(null)
const inputText = ref('')
const slashMenu = ref<InstanceType<typeof SlashCommandMenu>>()
const composerFocused = ref(false)
const composerComposing = ref(false)
const composerSelection = reactive({ start: 0, end: 0 })
function updateComposerSelection() {
  composerSelection.start = chatInput.value?.selectionStart ?? 0
  composerSelection.end = chatInput.value?.selectionEnd ?? 0
}
async function completeSlashCommand(text: string) {
  inputText.value = text
  await nextTick()
  chatInput.value?.focus({ preventScroll: true })
  chatInput.value?.setSelectionRange(text.length, text.length)
  updateComposerSelection()
  autoResize()
}
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
    if (!eventStream) throw new Error('Live updates are unavailable. Retry before continuing the request.')
    await eventStream.ready()
    await resumeChatRequest(props.apiBase, sessionId, recovery.id, control)
    if (control.state.requestId && finishedRequests.has(control.state.requestId)) control.finish()
    if (sessionRecoveries.value[sessionId]?.id === recovery.id) delete sessionRecoveries.value[sessionId]
    if (generation === sessionSelectionGeneration) {
      void loadSessionList()
      void loadCurrentSession()
    }
  } catch (error) {
    if (control.state.phase === 'preparing') control.finish()
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
const isExecution = computed(() => !!activeSessionId.value && isOneShot({ mode: activeSession.value?.mode ?? selectedMode.value }))
const isCall = computed(() => !!activeSessionId.value && (activeSession.value?.mode ?? selectedMode.value) === 'call')
const executionParent = computed(() => allSessions.value.find(session =>
  session.sessionId === activeSession.value?.parentSessionId && isOneShot(session)))
const activeSessionName = computed(() => {
  const session = activeSession.value
  if (session?.label && session.label !== session.sessionId && session.label !== session.sessionId.replace('web:', '')) return session.label
  return messages.value.find(isUserMessage)?.content.trim().split('\n')[0] || 'Conversation'
})
const detailsRevision = ref(0)
const settingsOverride = ref<ConversationSettings>()
const pendingDraftSettings = ref<ConversationSettings>()
const reasoningSettings = computed<ReasoningSettings>(() => settingsOverride.value ?? activeSession.value?.config ?? {})
const savingSettings = ref(false)
const settingsError = ref('')
let settingsRequest: AbortController | undefined
const draftSettingsKey = computed(() => createDraftSettingsKey(props.apiBase, props.projectId ?? '',
  props.managed ? props.initialFolder?.id : draftFolder.value?.id, !!props.openRemote))

function restoreDraftSettings(): void {
  if (activeSessionId.value) return
  try {
    const settings = loadDraftSettings(window.localStorage, draftSettingsKey.value)
    settingsOverride.value = pendingDraftSettings.value = settings
    modelOverride.value = settings?.model ?? ''
  } catch (cause) {
    settingsError.value = `Could not restore draft settings: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}
onMounted(restoreDraftSettings)

async function changeReasoningSettings(patch: ReasoningSettings): Promise<void> {
  await changeConversationSettings(patch)
}

async function changeConversationSettings(patch: ConversationSettings): Promise<void> {
  if (isExecution.value || awaitingCall.value) return
  const modelOnly = Object.keys(patch).length === 1 && 'model' in patch
  if (savingSettings.value || (!modelOnly && requestBusy.value) || pickingContext.value) return
  if ((!('model' in patch) || (patch.model ?? null) === (explicitModel.value || null))
    && (!('thinking' in patch) || (patch.thinking?.type ?? null) === (reasoningSettings.value.thinking?.type ?? null))
    && (!('reasoningEffort' in patch) || (patch.reasoningEffort ?? null) === (reasoningSettings.value.reasoningEffort ?? null))) return
  settingsError.value = ''
  if (!activeSessionId.value) {
    const settings = { ...pendingDraftSettings.value, ...patch }
    try {
      saveDraftSettings(window.localStorage, draftSettingsKey.value, settings)
      settingsOverride.value = pendingDraftSettings.value = settings
      modelOverride.value = settings.model ?? ''
    } catch (cause) {
      settingsError.value = `Could not save draft settings: ${cause instanceof Error ? cause.message : String(cause)}`
    }
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
    modelOverride.value = settings.model ?? ''
    allSessions.value = allSessions.value.map(session => session.sessionId === sessionId ? {
      ...session, config: { ...session.config, model: settings.model ?? undefined, thinking: settings.thinking ?? undefined, reasoningEffort: settings.reasoningEffort ?? undefined },
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
  if (stageRequest || !paneActive.value && currentRequest.value?.state.phase !== 'active') return
  if (!sessionListRequest && Date.now() - lastGraphRefresh >= 30_000) void loadSessionList()
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
      const callWaits = isRecord(snapshot) && isRecord(snapshot.waitingForCalls) ? snapshot.waitingForCalls : undefined
      if (callWaits) for (const session of allSessions.value) {
        const waiting = callWaits[session.sessionId]
        if (typeof waiting === 'boolean') session.waitingForCall = waiting
      }
      activeRequestIds.value = identities
      sessionRecoveries.value = recoveries
      stageError.value = ''
      if (deferActiveHistory && !sendRequest
        && (stages[activeSessionId.value] === 'idle' || stages[activeSessionId.value] === 'inactive')) {
        deferActiveHistory = false
        refreshDirectHistory()
      }
      if (observedActive && observedRequest === currentRequest.value && observedSessionId === activeSessionId.value
        && (stages[observedSessionId] === 'idle' || stages[observedSessionId] === 'inactive')
        && !sendRequest) {
        observedRequest?.finish()
        streaming.value = false
        streamPhase.value = undefined
        if (isDirectChat.value) refreshDirectHistory()
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

// Commands and cached panes share the application's one realtime connection.
let eventStream: LiveSubscription | null = null
let eventStreamKey = ''
let bgStreamState: StreamState = { accumulated: '' }
let streamRequestId: string | undefined
const finishedRequests = new Set<string>()
let directRefreshPending = false
let deferActiveHistory = false
let directRefreshTimer: ReturnType<typeof setTimeout> | undefined

function wantsLiveChat(): boolean {
  return paneActive.value || !!currentRequest.value && currentRequest.value.state.phase !== 'finished'
}

function refreshDirectHistory(): void {
  directRefreshPending = true
  if (disposed || !paneActive.value || !activeSessionId.value || viewingPhysicalId.value
    || sendRequest || historyRequest || directRefreshTimer !== undefined || deferActiveHistory && requestBusy.value) return
  directRefreshTimer = setTimeout(() => {
    directRefreshTimer = undefined
    if (disposed || !paneActive.value || !activeSessionId.value || viewingPhysicalId.value
      || sendRequest || historyRequest || !directRefreshPending || deferActiveHistory && requestBusy.value) return
    directRefreshPending = false
    void loadDirectChat(true)
  }, 50)
}

function connectEventStream(chatId: string): void {
  const projectId = props.projectId ?? liveProjectId(props.apiBase)
  const key = JSON.stringify([props.apiBase, projectId, chatId])
  if (eventStream && eventStreamKey === key) return
  closeEventStream()
  if (!wantsLiveChat() || disposed || viewingPhysicalId.value) return
  bgStreamState = { accumulated: '' }
  streamRequestId = undefined
  const subscription = livePool.client(props.apiBase).subscribe({ kind: 'chat', projectId, sessionId: `web:${chatId}` }, {
    reset() {
      if (eventStream !== subscription || activeSessionId.value !== `web:${chatId}`) return
      bgStreamState = { accumulated: '' }
      streamRequestId = undefined
      streamContent.value = ''
      refreshDirectHistory()
      void pollSessionStages()
    },
    event(envelope) {
      if (eventStream !== subscription || activeSessionId.value !== `web:${chatId}` || viewingPhysicalId.value) return
      const payload = envelope.payload
      if (!isStreamPayload(payload)) throw new Error('Invalid live conversation payload')
      if (envelope.requestId && payload.event !== 'session_message' && finishedRequests.has(envelope.requestId)) return
      if (payload.event === 'command_result' && payload.receipt) {
        const requestId = envelope.requestId ?? payload.receipt.id
        finishedRequests.add(requestId)
        if (finishedRequests.size > 64) finishedRequests.delete(finishedRequests.values().next().value!)
        const control = currentRequest.value
        if (control?.state.requestId === requestId) control.finish()
        if (paneActive.value && !historyRequest) {
          messages.value = mergeCommandResults(messages.value, [payload.receipt])
          scrollToBottom()
        }
        detailsRevision.value++
        refreshDirectHistory()
        void loadSessionList()
        return
      }
      if (envelope.requestId && payload.event !== 'turn_finished' && payload.event !== 'session_message') {
        if (streamRequestId && streamRequestId !== envelope.requestId) {
          bgStreamState = { accumulated: '' }
          streamContent.value = ''
          streamTimestamp.value = undefined
        }
        streamRequestId = envelope.requestId
        const current = currentRequest.value
        if (!current || current.state.phase === 'finished'
          || current.state.phase === 'active' && current.state.requestId !== envelope.requestId) {
          current?.finish()
          requestControls.set(activeSessionId.value, createChatRequestControl(
            props.apiBase, () => {}, fetch, activeSessionId.value, envelope.requestId,
          ))
        }
      }
      if (payload.event === 'turn_finished' && envelope.requestId) {
        finishedRequests.add(envelope.requestId)
        if (finishedRequests.size > 64) finishedRequests.delete(finishedRequests.values().next().value!)
        const control = currentRequest.value
        if (control?.state.requestId === envelope.requestId) control.finish()
      }
      if (payload.event === 'turn_finished') {
        if (streamRequestId === envelope.requestId
          || !streamRequestId && (!currentRequest.value?.state.requestId || currentRequest.value.state.requestId === envelope.requestId)) {
          streaming.value = false
          bgStreamState = { accumulated: '' }
          streamRequestId = undefined
          streamContent.value = ''
          streamPhase.value = undefined
          streamTimestamp.value = undefined
          streamingToolCallData.value = null
        }
        refreshDirectHistory()
        void pollSessionStages()
        return
      }
      if (!paneActive.value || historyRequest || directRefreshPending && !deferActiveHistory) {
        if (paneActive.value && (payload.event === 'response' || payload.event === undefined)) {
          streaming.value = true
          if (applyStreamPayload(payload, bgStreamState)) streaming.value = false
        }
        if (payload.done || payload.event === 'session_message') refreshDirectHistory()
        return
      }
      if (payload.event !== 'session_message') streaming.value = true
      if (applyStreamPayload(payload, bgStreamState)) {
        streaming.value = false
        refreshDirectHistory()
        void loadSessionList()
      }
    },
  })
  eventStream = subscription
  eventStreamKey = key
}

function closeEventStream(): void {
  if (eventStream) {
    eventStream.close()
    eventStream = null
  }
  eventStreamKey = ''
}

function disconnectEventStream(): void {
  closeEventStream()
  finishedRequests.clear()
  clearTimeout(directRefreshTimer)
  directRefreshTimer = undefined
  directRefreshPending = false
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

type ConversationPanel = 'conversation' | 'diagnosis'
const activePanel = ref<ConversationPanel>('conversation')
const diagnosisOpened = ref(false)
const conversationDocumentVisible = ref(true)
const knowledgeDocumentVisible = ref(false)
const composerVisible = computed(() => !knowledgeDocumentVisible.value && activePanel.value !== 'diagnosis')
function knowledgeNavigation(active: boolean, entryId?: string) {
  knowledgeDocumentVisible.value = active
  emit('knowledge-navigation', active, entryId)
}
const canQuoteSelection = computed(() => (!activeSessionId.value || isDirectChat.value) && !viewingPhysicalId.value && !submissionBusy.value)
function switchPanel(panel: ConversationPanel): void {
  activePanel.value = panel
  if (panel === 'diagnosis') diagnosisOpened.value = true
  else if (conversationDocumentVisible.value && activeSession.value && !isDirectChat.value && !viewingPhysicalId.value && !historyRequest) void loadReadonlySession(true)
}
function diagnosisVisibilityChanged(visible: boolean) {
  const panel = visible ? 'diagnosis' : 'conversation'
  if (panel !== activePanel.value) switchPanel(panel)
}
interface ChatMsg {
  role: string
  content: string
  commandReceipt?: CommandReceipt
  senderName?: string
  sessionSource?: SessionMessageSource
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
const displayMessages = computed(() => messages.value.map(msg => ({
  ...msg, attachmentBody: messageAttachments(msg.content, msg.media),
})))
const inlineExecutions = computed(() => inlineExecutionMessages(
  displayMessages.value, allSessions.value, activeSessionId.value, sessionStages.value, streaming.value,
))
const unlinkedExecutions = computed(() => {
  const linked = new Set([...inlineExecutions.value.entries.values()].map(execution => execution.sessionId))
  return ownedExecutions(allSessions.value, activeSessionId.value).filter(execution => !linked.has(execution.sessionId))
})
const messageActions = computed(() => inlineMessageActions(displayMessages.value, allSessions.value))
const toolActivity = computed(() => groupToolActivity(displayMessages.value, new Set([
  ...inlineExecutions.value.excluded, ...messageActions.value.excluded,
])))
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
const imagePreview = shallowRef<ImagePreview>()
function openImagePreview(image: ImagePreview) { clearSelection(); imagePreview.value = image }
function previewImageKeydown(event: KeyboardEvent) {
  const image = imagePreviewFromEvent(event)
  if (!image) return
  event.preventDefault()
  event.stopPropagation()
  openImagePreview(image)
}
watch([() => props.apiBase, () => props.projectId, () => props.sessionId, activeSessionId, viewingPhysicalId, paneActive, conversationDocumentVisible, activePanel, () => route.fullPath],
  () => { imagePreview.value = undefined })
watch(() => pendingAttachments.value.map(item => item.previewUrl), (urls, previous) => {
  if (imagePreview.value && previous.includes(imagePreview.value.src) && !urls.includes(imagePreview.value.src)) imagePreview.value = undefined
})
const physicalIdStack = ref<string[]>([])
const { after: ioAfter, earlier: ioEarlier, error: ioError } = useIoConversation(
  () => paneActive.value && conversationDocumentVisible.value && activePanel.value === 'conversation' &&
    route.name === 'chat' && activeSessionId.value && !viewingPhysicalId.value
    ? { apiBase: props.apiBase, sessionId: activeSessionId.value, projectId: props.projectId, remote: remoteConversation.value }
    : undefined,
  () => displayMessages.value,
)

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
        const entry: ChatMsg = { role: 'user', content, senderName: senderNames[i], timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : undefined,
          ...parseSessionMessage(msg) }
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

async function loadSessionList(signal?: AbortSignal): Promise<void> {
  sessionListRequest?.abort()
  const controller = new AbortController()
  sessionListRequest = controller
  lastGraphRefresh = Date.now()
  sessionsLoading.value = true
  sessionsError.value = ''
  const requestSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(15_000)])
  try {
    const res = await fetch(buildUrl('/api/sessions/graph'), {
      signal: requestSignal,
    })
    if (!res.ok) throw new Error('Cannot load conversations. Check Main and retry.')
    const data = await res.json()
    if (!requestSignal.aborted) {
      const sessions = parseSessionGraph(data, props.projectId)
      if (!props.managed) homeCache.setSessions(props.apiBase, sessions)
      const selected = sessions.find(session => session.sessionId === activeSessionId.value)
      if (activeSession.value && !selected) composerError.value = 'This conversation or execution is no longer available. Close it and refresh the conversation list.'
      if (selected) selectedMode.value = selected.mode
      allSessions.value = sessions
    }
  } catch (cause) {
    if (!controller.signal.aborted && !signal?.aborted) sessionsError.value = cause instanceof Error && cause.message.startsWith('Cannot ')
      ? cause.message : 'Cannot load conversations. Check Main and retry.'
  } finally {
    if (sessionListRequest === controller) {
      sessionListRequest = undefined
      sessionsLoading.value = false
    }
  }
}

watch(() => [props.apiBase, props.projectId, paneActive.value] as const, ([base, projectId, active], _previous, onCleanup) => {
  if (!active) return
  const refresh = createLiveRefresh({
    load: loadSessionList,
    apply: () => { void pollSessionStages() },
    onError: () => { sessionsError.value = 'Cannot load conversations. Check Main and retry.' },
  })
  const subscription = livePool.client(base).subscribe({
    kind: 'sessions', projectId: projectId ?? liveProjectId(base),
  }, { event: () => refresh.refresh(), reset: () => refresh.refresh() })
  onCleanup(() => {
    subscription.close()
    refresh.dispose()
    stageRequest?.abort()
    stageRequest = undefined
  })
}, { immediate: true })

function toggleCollapse(sessionId: string): void {
  if (collapsedSessions.has(sessionId)) {
    collapsedSessions.delete(sessionId)
  } else {
    collapsedSessions.add(sessionId)
  }
}

const executionLocationSelector = ref<InstanceType<typeof ExecutionLocationSelector>>()
const composerOptions = ref<InstanceType<typeof ComposerPopover>>()
async function chooseRemoteExecution() {
  if (mobileLayout.value) { await composerOptions.value?.show(); await nextTick() }
  await executionLocationSelector.value?.openRemote()
}

function createNewWebChat(folder?: FolderRecord, syncRoute = true, openRemotePicker = false): void {
  resetConversation()
  draftFolder.value = folder
  draft.value = createFolderChatDraft(foldersClient, folder)
  activeSessionId.value = ''
  restoreDraftSettings()
  mobileSidebarOpen.value = false
  if (!props.embedded && syncRoute) {
    emit('primary-change', '')
    if (props.managed) emit('navigate', '')
    else void router.replace({ name: 'chat', params: { projectId: props.projectId } })
  }
  void nextTick(async () => {
    workbench.value?.showConversation()
    await nextTick()
    autoResize()
    if (props.visible && props.keyboardActive) {
      if (openRemotePicker) await chooseRemoteExecution()
      else chatInput.value?.focus({ preventScroll: true })
    }
  })
}

function selectExecutionLocation(target: ExecutionLocation | undefined): void {
  if (preparingSend.value || activeSessionId.value) return
  if ((target?.kind === 'node' || target?.kind === 'folder' && target.folder.kind === 'remote') && (contextItems.value.length || pendingAttachments.value.length)) {
    composerError.value = 'Remove local attachments before selecting a remote workspace. Files are not transferred between devices.'
    return
  }
  try {
    const next = createExecutionLocationDraft(props.apiBase, props.projectId || liveProjectId(props.apiBase), foldersClient, target)
    draft.value = next
    draftFolder.value = next.folder
    composerError.value = ''
  } catch (cause) {
    composerError.value = cause instanceof Error ? cause.message : 'Could not select this execution location. Refresh and retry.'
  }
}

function clearPendingAttachments(): void {
  revokeChatAttachmentPreviews(pendingAttachments.value)
  pendingAttachments.value = []
  imageEditsBusy.value.clear()
  attachmentDropTarget.value = false
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

function isAttachmentDrop(data: DataTransfer | null): boolean {
  return hasImageReference(data) || !!data && Array.from(data.types).includes('Files')
}

function handleAttachmentDragOver(event: DragEvent): void {
  if (!isAttachmentDrop(event.dataTransfer)) return
  event.preventDefault()
  const allowed = canQuoteSelection.value && canAttachFiles.value
  if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
  attachmentDropTarget.value = allowed
}

function handleAttachmentDragLeave(event: DragEvent): void {
  if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
  attachmentDropTarget.value = false
}

function handleAttachmentDrop(event: DragEvent): void {
  if (!isAttachmentDrop(event.dataTransfer)) return
  event.preventDefault()
  event.stopPropagation()
  attachmentDropTarget.value = false
  if (!canQuoteSelection.value || !canAttachFiles.value) {
    composerError.value = remoteConversation.value
      ? 'Local attachments are not transferred to remote workspaces.'
      : 'This conversation cannot receive file attachments right now.'
    return
  }
  try {
    const reference = readImageReference(event.dataTransfer)
    if (reference) {
      pendingAttachments.value = updateImageAttachment(pendingAttachments.value, reference.sourceKey, reference.file, { source: reference.source })
    } else {
      const files = droppedChatFiles(event.dataTransfer)
      if (!files.length) throw new Error('No files were found in this drop. Drop files or use Add file.')
      pendingAttachments.value = appendChatAttachments(pendingAttachments.value, files)
    }
    composerError.value = ''
  } catch (cause) {
    composerError.value = cause instanceof Error ? cause.message : 'Could not attach the files. Drop them again.'
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

function deleteSession(sessionId: string): void {
  if (deletion.value) return
  deletion.value = { apiBase: props.apiBase, sessionId, name: allSessions.value.find(session => session.sessionId === sessionId)?.label || sessionId }
}
async function sessionsDeleted(ids: string[]): Promise<void> {
  deletion.value = undefined
  const activeDeleted = ids.includes(activeSessionId.value)
  for (const id of ids) emit('deleted', id)
  if (activeDeleted) createNewWebChat()
  await loadSessionList()
}

function resetConversation(): void {
  deletion.value = undefined
  deferActiveHistory = false
  modelOverride.value = undefined
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
  submittingMessage.value = false
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
  historyBrowsing = false
  historyLeftBottom = false
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

async function loadDirectChat(background = false): Promise<void> {
  if (deferActiveHistory && requestBusy.value && messages.value.length) return
  historyRequest?.abort()
  const controller = new AbortController()
  historyRequest = controller
  const chatId = activeSessionId.value.replace('web:', '')
  const sessionId = activeSessionId.value
  directRefreshPending = false
  let followBottom = false
  if (!background) loadingHistory.value = true
  try {
    const res = await fetch(buildUrl('/api/chat/session', { chatId }), { signal: controller.signal })
    if (!res.ok) throw new Error('Could not load conversation. Refresh to retry.')
    const data = await res.json()
    if (controller.signal.aborted) return
    const container = messagesContainer.value
    followBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 32
    messages.value = mergeCommandResults(collapseHistory(data.history ?? []), data.commandResults)
    if (!sendRequest && !streaming.value) {
      streaming.value = false
      streamContent.value = ''
      streamPhase.value = undefined
      streamTimestamp.value = undefined
      streamingToolCallData.value = null
    }
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
      if (!background || followBottom) scrollToBottom()
      if (directRefreshPending) refreshDirectHistory()
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
    messages.value = mergeCommandResults(collapseHistory(rawMessages), histData.commandResults)
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
    messages.value = mergeCommandResults(collapseHistory(rawMessages), data.commandResults)
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
  if (slashMenu.value?.handleKeyDown(e)) return
  if (mobileLayout.value && !e.ctrlKey && !e.metaKey) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    void sendMessage()
  }
}

/** Transient output; persisted history is authoritative after resets and completion. */
interface StreamState { accumulated: string; timestamp?: string }

/** A decoded SSE payload emitted by the web channel. */
interface StreamPayload {
  event?: 'response' | 'tool_call' | 'tool_result' | 'session_message' | 'turn_finished' | 'command_result'
  receipt?: CommandReceipt
  content?: string
  done?: boolean
  media?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  toolCall?: { name: string; arguments: Record<string, unknown> }
  toolCallId?: string
  toolName?: string
  message?: unknown
}

function isStreamPayload(value: unknown): value is StreamPayload {
  if (!isRecord(value)
    || (value.event !== undefined && !['response', 'tool_call', 'tool_result', 'session_message', 'turn_finished', 'command_result'].includes(String(value.event)))
    || (value.content !== undefined && typeof value.content !== 'string')
    || (value.done !== undefined && typeof value.done !== 'boolean')
    || (value.media !== undefined && (!Array.isArray(value.media) || !value.media.every(item => typeof item === 'string')))
    || (value.toolCallId !== undefined && typeof value.toolCallId !== 'string')
    || (value.toolName !== undefined && typeof value.toolName !== 'string')
    || (value.toolCall !== undefined && (!isRecord(value.toolCall) || typeof value.toolCall.name !== 'string' || !isRecord(value.toolCall.arguments)))
    || (value.usage !== undefined && (!isRecord(value.usage) || !['promptTokens', 'completionTokens', 'totalTokens'].every(key => {
      const count = isRecord(value.usage) ? value.usage[key] : undefined
      return typeof count === 'number' && Number.isFinite(count) && count >= 0
    })))) return false
  if (value.event === 'session_message') return !!parseLiveSessionMessage(value.message)
  if (value.event === 'command_result') return value.done === true && isCommandReceipt(value.receipt)
  if (value.event === 'turn_finished') return value.done === true && ['completed', 'failed', 'cancelled'].includes(String(value.status)) && typeof value.turnId === 'string'
  return true
}

/**
 * Apply a validated shared-feed payload. Returns true at the end of a turn.
 */
function applyStreamPayload(payload: StreamPayload, state: StreamState): boolean {
  const event = payload.event ?? 'response'
  if (event === 'session_message') {
    const parsed = parseLiveSessionMessage(payload.message)
    if (!parsed) throw new Error('Invalid live event message')
    const eventId = 'eventMeta' in parsed ? parsed.eventMeta.attrs['event-id'] : undefined
    if (eventId && messages.value.some(message => message.eventMeta?.attrs['event-id'] === eventId)) return false
    if (state.accumulated) {
      messages.value.push({ role: 'assistant', content: state.accumulated, timestamp: state.timestamp })
      state.accumulated = ''
      state.timestamp = undefined
      streamContent.value = ''
      streamTimestamp.value = undefined
    }
    messages.value.push({ ...parsed, media: payload.media })
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
    composerError.value = 'Project models are unavailable. Retry models or update this project’s model settings.'
    return
  }
  if (isExecution.value) {
    composerError.value = 'Tasks and calls are read-only. Send a message in the owning conversation instead.'
    return
  }
  if (props.embedded && !activeSession.value && !opts?.parentSessionId) {
    composerError.value = 'This child conversation is unavailable. Close it and refresh the conversation list.'
    return
  }
  const retry = opts?.retry === true
  const content = retry ? '' : composeChatMessage(overrideContent ?? inputText.value.trim(), contextItems.value)
  const isCommand = !retry && content.trimStart().startsWith('/')
  const attachments = retry ? [] : [...pendingAttachments.value]
  const model = explicitModel.value
  const savedDraftKey = pendingDraftSettings.value ? draftSettingsKey.value : undefined
  if (remoteConversation.value && (attachments.length || contextItems.value.length)) {
    composerError.value = 'Remove local attachments before sending to a remote workspace.'
    return
  }
  if ((!content && !retry && attachments.length === 0) || submissionBusy.value || currentRequest.value?.state.stopping
    || !installation.value.uiScopes.includes('chat:write') || retry && requestBusy.value
    || pickingContext.value || savingSettings.value || imageEditsBusy.value.size > 0) return
  const followUp = requestBusy.value
  submittingMessage.value = true
  const generation = sessionSelectionGeneration
  const controller = new AbortController()
  sendRequest = controller
  const priorRecoveryId = currentRecovery.value?.id
  const control = createChatRequestControl(props.apiBase, () => controller.abort())
  if (activeSessionId.value) {
    if (!followUp) requestControls.set(activeSessionId.value, control)
  } else draftRequest.value = control
  const startingDraft = !activeSessionId.value
  preparingSend.value = startingDraft
  composerError.value = ''
  let accepted = false
  let submitted = false
  let rejected = false
  let messageAdded = retry
  let optimisticMessage: ChatMsg | undefined

  try {
    const sessionId = activeSessionId.value || await draft.value.prepare(controller.signal)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    if (!followUp) requestControls.set(sessionId, control)
    draftRequest.value = undefined
    // Never load context/history for a draft: that endpoint materializes a session.
    historyRequest?.abort()
    historyRequest = undefined
    loadingHistory.value = false
    if (startingDraft && draftRemote.value) currentWorkdir.value = { kind: 'remote', displayPath: draftRemote.value.displayPath ?? null }
    activeSessionId.value = sessionId
    if (props.managed) emit('prepared', sessionId)
    else if (!props.embedded) void router.replace({ name: 'chat', params: { projectId: props.projectId, sessionId }, query: startingDraft || opts?.parentSessionId ? {} : route.query })
    preparingSend.value = false
    workbench.value?.showConversation()
    activePanel.value = 'conversation'
    clearSelection()
    if (!followUp && !isCommand) {
      streaming.value = true
      streamPhase.value = 'llm'
      streamContent.value = ''
      streamTimestamp.value = undefined
      streamingToolCallData.value = null
    }
    scrollToBottom()

    const chatId = sessionId.replace('web:', '')
    const uploadedAttachments = retry ? [] : await uploadChatAttachments(props.apiBase, chatId, attachments, controller.signal, fetch, opts?.parentSessionId)
    const uploadedMedia = retry ? [...(opts?.retryMedia ?? [])] : uploadedAttachments.map(attachment => attachment.path)
    const messageContent = composeImageReferenceMessage(content, uploadedAttachments)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    connectEventStream(chatId)
    if (!eventStream) throw new Error('Live updates are unavailable. Retry before sending.')
    await eventStream.ready(controller.signal)
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    const payload: Record<string, unknown> = {
      chatId,
      senderId: 'admin',
      stream: false,
    }
    if (retry) {
      payload.retry = true
      // Fallback content used only if the original request never reached the backend.
      if (opts?.retryContent) payload.content = opts.retryContent
      if (uploadedMedia.length > 0) payload.media = uploadedMedia
    } else {
      payload.content = messageContent
      if (uploadedMedia.length > 0) payload.media = uploadedMedia
      if (!isCommand) {
        const msg: ChatMsg = { role: 'user', content: messageContent, timestamp: new Date().toISOString() }
        if (uploadedMedia.length > 0) msg.media = uploadedMedia
        optimisticMessage = msg
        messages.value.push(msg)
      }
      messageAdded = true
    }
    if (opts?.parentSessionId) payload.parentSessionId = opts.parentSessionId
    if (pendingDraftSettings.value || model) payload.config = { ...pendingDraftSettings.value, ...(model ? { model } : {}) }

    control.submitting(sessionId)
    submitted = true
    const res = await fetch(buildUrl('/api/chat/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    })

    if (!res.ok) {
      rejected = true
      throw new Error(`Could not send message (${res.status} ${res.statusText}). Retry when Main is available.`)
    }
    const admission: unknown = await res.json()
    if (!isRecord(admission) || admission.chatId !== chatId || typeof admission.requestId !== 'string' || !admission.requestId) {
      throw new Error('Main did not confirm the request identity. Refresh activity before retrying; the request may be running.')
    }
    if (admission.commandReceipt !== undefined && !isCommandReceipt(admission.commandReceipt)) {
      throw new Error('Main returned an invalid command result. Refresh the conversation before retrying.')
    }
    accepted = true
    if (generation === sessionSelectionGeneration) historyBrowsing = false
    // Steered inputs are admitted before the tool boundary writes them to history.
    if (followUp && !isCommand && generation === sessionSelectionGeneration) deferActiveHistory = true
    if (!retry && generation === sessionSelectionGeneration) {
      inputText.value = ''
      clearPendingAttachments()
      contextItems.value = []
      if (chatInput.value) chatInput.value.style.height = 'auto'
    }
    if (sessionRecoveries.value[sessionId]?.id === priorRecoveryId) delete sessionRecoveries.value[sessionId]
    control.admitted(admission.requestId)
    if (isCommandReceipt(admission.commandReceipt)) {
      control.finish()
      if (generation === sessionSelectionGeneration && !viewingPhysicalId.value) {
        messages.value = mergeCommandResults(messages.value, [admission.commandReceipt])
        detailsRevision.value++
        refreshDirectHistory()
      }
    }
    if (finishedRequests.has(admission.requestId)) control.finish()
    if (savedDraftKey) {
      try { window.localStorage.removeItem(savedDraftKey) }
      catch (cause) { settingsError.value = `Conversation saved, but draft settings could not be cleared: ${cause instanceof Error ? cause.message : String(cause)}` }
    }
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) {
      controller.abort()
      return
    }
    pendingDraftSettings.value = undefined
    void loadSessionList()
  } catch (err) {
    if (controller.signal.aborted || generation !== sessionSelectionGeneration) return
    if (rejected && optimisticMessage) {
      const index = messages.value.indexOf(optimisticMessage)
      if (index >= 0) messages.value.splice(index, 1)
    }
    if (isCommand || followUp || !activeSessionId.value || !messageAdded || rejected) {
      composerError.value = err instanceof Error ? err.message : 'Could not start the conversation. Retry.'
    } else {
      messages.value.push({ role: 'assistant', content: `Error: ${err}`, isError: true, timestamp: new Date().toISOString() })
    }
  } finally {
    if (!submitted || rejected) control.finish()
    else if (control.state.phase === 'submitting') control.admitted()
    if (generation === sessionSelectionGeneration) {
      if (sendRequest === controller) {
        sendRequest = undefined
        submittingMessage.value = false
      }
      preparingSend.value = false
      if (!followUp && (!accepted || control.state.phase === 'finished')) {
        streaming.value = false
        streamPhase.value = undefined
        streamContent.value = ''
        streamTimestamp.value = undefined
        streamingToolCallData.value = null
      }
      scrollToBottom()
      if (directRefreshPending || accepted && !systemPrompt.value) refreshDirectHistory()
      if (followUp) void pollSessionStages()
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
  const last = resendableUserMessage(messages.value)
  const retryContent = last?.content
  const retryMedia = last?.media
  void sendMessage(undefined, { retry: true, retryContent, retryMedia })
}

/** Tool events are committed immediately so parallel results cannot overwrite each other. */
function flushStreamingTool(): void {
  streamingToolCallData.value = null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function browseHistory(): void {
  historyBrowsing = true
  historyLeftBottom = false
}

function trackHistoryScroll(): void {
  const container = messagesContainer.value
  if (!historyBrowsing || !container) return
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 32
  // A smooth jump starts at the bottom; only resume following after returning there.
  if (!atBottom) historyLeftBottom = true
  else if (historyLeftBottom) historyBrowsing = false
}

function scrollToBottom(): void {
  nextTick(() => {
    if (historyBrowsing || !props.visible || !conversationDocumentVisible.value || activePanel.value !== 'conversation') return
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

function preprocessCustomXml(text: string): string {
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

  return imagePreviewMarkup(mobileResources.html(DOMPurify.sanitize(html, {
    ADD_TAGS: [...KATEX_TAGS, 'img'],
    ADD_ATTR: [...KATEX_ATTRS, 'target', 'rel', 'src', 'alt', 'loading', 'class'],
  })))
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
  const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], .folder-dialog-backdrop, .folder-menu-backdrop, .composer-popover-backdrop, .workbench-explorer.drawer'))
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
  const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId
  if (!projectId || projectId === props.projectId) detailsRevision.value++
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
  if (paneActive.value) startStagePolling()
  if (props.embedded) {
    await loadEmbeddedSession(props.sessionId ?? '')
    return
  }
  if (props.managed) {
    if (props.sessionId) {
      selectSession(props.sessionId, false)
    } else if (props.openRemote) {
      await nextTick()
      if (props.visible) await chooseRemoteExecution()
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
watch(paneActive, visible => {
  if (!mounted) return
  if (visible) {
    startStagePolling()
    if (isDirectChat.value && !viewingPhysicalId.value) {
      connectEventStream(activeSessionId.value.replace('web:', ''))
      if (!sendRequest) refreshDirectHistory()
    }
  } else {
    stopStagePolling()
    if (!wantsLiveChat()) closeEventStream()
    if (isDirectChat.value && !viewingPhysicalId.value) {
      historyRequest?.abort()
      historyRequest = undefined
      loadingHistory.value = false
    }
  }
}, { flush: 'sync' })
watch(() => [wantsLiveChat(), activeSessionId.value, viewingPhysicalId.value, props.apiBase], () => {
  if (!mounted || disposed) return
  if (wantsLiveChat() && isDirectChat.value && !viewingPhysicalId.value) connectEventStream(activeSessionId.value.replace('web:', ''))
  else closeEventStream()
}, { flush: 'sync' })
watch(composerDock, element => {
  dockObserver?.disconnect()
  if (!element) return
  dockObserver = new ResizeObserver(() => {
    if (!props.visible || !composerVisible.value || !element.getClientRects().length) return
    const container = messagesContainer.value
    const followBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 32
    dockHeight.value = element.getBoundingClientRect().height
    if (followBottom) void nextTick(() => { if (container && !historyBrowsing) container.scrollTop = container.scrollHeight })
  })
  dockObserver.observe(element)
}, { flush: 'post' })
const resendCandidate = computed(() => resendableUserMessage(messages.value))
const canResend = computed(() => !requestBusy.value && !currentRecovery.value && !!resendCandidate.value)
const historyMarkers = computed(() => messageHistoryMarkers(messages.value, allSessions.value))

function resendLastMessage() {
  const message = resendCandidate.value
  if (!canResend.value || !message) return
  void sendMessage(undefined, { retry: true, retryContent: message.content, retryMedia: message.media })
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
.chat-panel { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
.conversation-heading-row { display: flex; align-items: center; flex-shrink: 0; min-width: 0; }
.conversation-heading-row > :deep(.session-heading) { flex: 1; }
.conversation-dock { position: absolute; inset: auto 0 0; display: flex; flex-direction: column; pointer-events: none; z-index: 3; }
.conversation-dock:not(.in-flow):has(> .chat-composer)::before {
  content: '';
  position: absolute;
  inset: -16px 0 0;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    transparent 0,
    color-mix(in srgb, var(--c-bg) 10%, transparent) 32px,
    color-mix(in srgb, var(--c-bg) 50%, transparent) 80px,
    color-mix(in srgb, var(--c-bg) 90%, transparent) 128px,
    var(--c-bg) 160px
  );
}
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
.draft-folder { display: inline-flex; align-items: center; gap: 16px; box-sizing: border-box; max-width: 100%; margin-top: 20px; padding: 16px 22px; border: 1px solid color-mix(in srgb, var(--c-blue) 40%, var(--c-border)); border-radius: var(--radius-surface); background: color-mix(in srgb, var(--c-blue) 8%, var(--c-bg-card)); text-align: left; }
.draft-folder-icon { flex: 0 0 34px; width: 34px; height: 34px; color: var(--c-blue); }
.draft-folder-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.draft-folder-label { color: var(--c-blue); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.draft-folder strong { color: var(--c-text); font-size: 24px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.draft-folder-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-secondary); font-size: 12px; }
.draft-heading .draft-scratch { margin-top: 14px; }
.draft-io { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 18px; }
.chat-history { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; container-type: inline-size; }
.chat-messages { position: relative; flex: 1; min-height: 0; min-width: 0; overflow-y: auto; scrollbar-gutter: stable both-edges; padding-block: 12px calc(var(--composer-height, 0px) + 16px); scroll-padding-bottom: calc(var(--composer-height, 0px) + 16px); overflow-wrap: anywhere; overscroll-behavior: contain; }
.chat-working { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; box-sizing: border-box; width: calc(100% - 40px); max-width: 860px; margin: 8px auto 0; padding: 11px 14px; border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); background: var(--c-chat-action-bg); color: var(--c-text-secondary); }
.chat-working.waiting { border-color: var(--c-warn); background: var(--c-warn-bg); color: var(--c-warn); }
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
.composer-box { padding: 12px 12px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-input); transition: border-color .15s ease; }
.composer-box:focus-within, .composer-box:has(.composer-control[aria-expanded="true"]) { border-color: var(--c-blue); }
.composer-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.composer-input { display: flex; min-width: 0; }
.composer-input textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; min-height: 78px; max-height: min(240px, 28dvh); overflow-y: auto; resize: none; padding: 3px 4px 10px; border: 0; outline: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 14px; line-height: 1.6; }
.composer-input textarea::placeholder { color: var(--c-text-secondary); }
.composer-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 4px; min-width: 0; }
.composer-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: calc(100% - 42px); }
.composer-send { margin-left: auto; flex-shrink: 0; }
.composer-box.attachment-drop-target { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.composer-send { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-control); background: var(--c-primary-bg); color: var(--c-text-on-primary); cursor: pointer; }
.composer-send:disabled { opacity: .35; cursor: not-allowed; }
.composer-send:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.composer-stop:disabled { opacity: .65; cursor: not-allowed; }
.resume-bar { display: flex; align-items: center; gap: 16px; padding: 12px 14px; margin-bottom: 10px; border: 1px solid var(--c-border-hover); border-radius: var(--radius-surface); background: var(--c-bg); color: var(--c-text); }
.resume-bar p { margin: 4px 0 0; font-size: 12px; line-height: 1.45; }
.resume-button { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 36px; padding: 8px 12px; border: 0; border-radius: var(--radius-control); background: var(--c-primary-bg); color: var(--c-text-on-primary); cursor: pointer; }
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
.context-chip .attachment-preview { display: grid; place-items: center; width: auto; min-height: 0; padding: 0; cursor: zoom-in; }
.prose :deep([data-image-preview]) { cursor: zoom-in; }
.prose :deep([data-image-preview]:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
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
  .draft-folder { padding: 14px; gap: 12px; }
  .draft-folder strong { font-size: 21px; }
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
  border: 1px solid var(--c-chat-border);
  border-radius: var(--radius-control);
  padding: 0.25rem 0.5rem;
  background: var(--c-chat-action-bg);
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
  color: var(--c-text-secondary);
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

/* ── Chat messages ──────────────────────────────────────────── */

.chat-message-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* Use the pane's width, not the scrollbar-reduced scrollport, to stay centered with the composer. */
  width: calc(100cqw - 112px);
  margin-inline: auto;
}

.mobile-chat { --conversation-item-max-width: 100%; }
.mobile-chat .chat-messages { scrollbar-gutter: auto; }
.mobile-chat .chat-message-list { width: auto; margin-inline: max(8px, env(safe-area-inset-left, 0px)) max(8px, env(safe-area-inset-right, 0px)); }
.mobile-chat .chat-bubble { box-sizing: border-box; max-width: 100%; }
.mobile-chat .chat-user { max-width: 92%; }
.mobile-chat .chat-working, .mobile-chat .chat-composer { width: calc(100% - max(8px, env(safe-area-inset-left, 0px)) - max(8px, env(safe-area-inset-right, 0px))); }
.mobile-chat .chat-composer { margin: 8px auto max(8px, env(safe-area-inset-bottom, 0px)); }
.mobile-history summary { min-height: 44px; box-sizing: border-box; padding: 12px 10px; font-size: 14px; cursor: pointer; }
.mobile-history summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-chat .composer-box { position: relative; padding: 8px 52px; }
.mobile-chat .composer-input textarea { min-height: 44px; max-height: min(200px, 28dvh); padding: 10px 0; font-size: 16px; line-height: 1.5; }
.mobile-chat .composer-toolbar { position: absolute; bottom: 8px; left: 8px; right: 8px; margin: 0; pointer-events: none; }
.mobile-chat .composer-controls, .mobile-chat .composer-submit { pointer-events: auto; flex: 0 0 44px; max-width: 44px; }
.mobile-chat .composer-send, .mobile-chat .composer-controls :deep(> .composer-control) { width: 44px; height: 44px; min-height: 44px; padding: 0; justify-content: center; }
.mobile-chat .composer-hint { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mobile-chat .composer-context { margin-inline: -44px; }
.mobile-message-settings { display: flex; flex-direction: column; padding-top: 8px; border-top: 1px solid var(--c-border); }
.mobile-composer-note { margin: 4px 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
.mobile-message-settings :deep(.composer-control), .mobile-message-settings .context-action { width: 100%; min-height: 44px; justify-content: flex-start; font-size: 14px; }
.conversation-empty { color: var(--c-text-secondary); font-size: 14px; user-select: none; }

.chat-message-list > :deep(:is(.chat-assistant, .system-event, .compaction-summary, .tool-activity, .execution-card, .message-action)) {
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
  border: 1px solid var(--c-chat-border);
}

.chat-user {
  align-self: flex-end;
  background: var(--c-chat-user-bg);
  color: var(--c-text);
  border-color: var(--c-chat-border);
}

.chat-assistant {
  align-self: flex-start;
  background: var(--c-chat-assistant-bg);
  color: var(--c-text);
}

.chat-session { box-shadow: none; border-style: dashed; }
.chat-session-source { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-bottom: 8px; padding: 0; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; text-align: left; }
button.chat-session-source { cursor: pointer; }
button.chat-session-source:hover { color: var(--c-text); text-decoration: underline; }
button.chat-session-source:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
.chat-session-source strong { font-weight: 600; color: var(--c-text-secondary); }
.chat-session-source > span { min-width: 0; overflow-wrap: anywhere; }

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
