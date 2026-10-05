<template>
  <div ref="root" class="file-workbench" :class="{ 'explorer-docked': expanded && wide, 'mobile-workbench': mobileLayout }" :style="{ '--explorer-width': `${explorerWidth}px` }">
    <Teleport v-if="mobileHeader.visible.value && mobileHeader.chrome?.headerTarget.value" :to="mobileHeader.chrome.headerTarget.value">
      <button ref="mobileTitleButton" class="mobile-document-title" type="button" aria-label="Switch view" aria-haspopup="dialog" :aria-expanded="viewsOpen" @click="viewsOpen = true">
        <span>{{ selectedTitle }}</span><span class="i-lucide-chevron-down" aria-hidden="true" />
      </button>
      <button ref="mobileActionsButton" class="mobile-document-more" type="button" aria-label="Conversation and document actions" aria-haspopup="dialog" :aria-expanded="actionsOpen" @click="actionsOpen = true">
        <span class="i-lucide-ellipsis w-5 h-5" aria-hidden="true" />
      </button>
    </Teleport>
    <MobileSheet v-if="mobileLayout" :open="viewsOpen" label="Open views" :return-focus="mobileTitleButton" @update:open="viewsOpen = $event">
      <div class="mobile-view-row"><button :aria-current="tabs.selected === '' ? 'page' : undefined" @click="chooseMobileView('')"><span :class="primaryIcon" aria-hidden="true" /><span>{{ primaryLabel || conversationTitle || 'Conversation' }}</span></button></div>
      <div v-if="tabs.diagnosis" class="mobile-view-row"><button :aria-current="tabs.selected === DIAGNOSIS_TAB_KEY ? 'page' : undefined" @click="chooseMobileView(DIAGNOSIS_TAB_KEY)"><span class="i-lucide-activity" aria-hidden="true" /><span>Diagnosis</span></button></div>
      <div v-if="knowledgeEnabled" class="mobile-view-row">
        <button :aria-current="tabs.selected === KNOWLEDGE_TAB_KEY ? 'page' : undefined" @click="chooseMobileKnowledge"><span class="i-lucide-book-open" aria-hidden="true" /><span>Knowledge</span></button>
        <button v-if="tabs.knowledge" class="mobile-view-close" aria-label="Close Knowledge" @click="closeFile(KNOWLEDGE_TAB_KEY, false)"><span class="i-lucide-x" aria-hidden="true" /></button>
      </div>
      <div v-for="entryId in tabs.knowledgeEntries ?? []" :key="entryId" class="mobile-view-row">
        <button :aria-current="tabs.selected === knowledgeEntryTabKey(entryId) ? 'page' : undefined" @click="chooseMobileView(knowledgeEntryTabKey(entryId))"><span class="i-lucide-book-open" aria-hidden="true" /><span>{{ knowledgeLabel(entryId) }}</span></button>
        <button class="mobile-view-close" :aria-label="`Close ${knowledgeLabel(entryId)}`" @click="closeFile(knowledgeEntryTabKey(entryId), false)"><span class="i-lucide-x" aria-hidden="true" /></button>
      </div>
      <div v-for="tab in tabs.projectTabs ?? []" :key="tab" class="mobile-view-row">
        <button :aria-current="tabs.selected === projectTabKey(tab) ? 'page' : undefined" @click="chooseMobileView(projectTabKey(tab))"><span :class="tab === 'settings' ? 'i-lucide-settings-2' : 'i-lucide-bot'" aria-hidden="true" /><span>{{ tab === 'settings' ? 'Project settings' : 'Agents' }}</span></button>
        <button class="mobile-view-close" :aria-label="`Close ${tab === 'settings' ? 'Project settings' : 'Agents'}`" @click="closeFile(projectTabKey(tab), false)"><span class="i-lucide-x" aria-hidden="true" /></button>
      </div>
      <div v-for="file in tabs.files" :key="fileTabKey(file)" class="mobile-view-row">
        <button :aria-current="tabs.selected === fileTabKey(file) ? 'page' : undefined" @click="chooseMobileView(fileTabKey(file))"><span :class="file.view === 'diff' ? 'i-lucide-file-diff' : fileIcon(file.entry.name)" aria-hidden="true" /><span>{{ file.path }}{{ file.view === 'diff' ? ' (changes)' : '' }}</span></button>
        <button class="mobile-view-close" :aria-label="`Close ${file.path}`" @click="closeFile(fileTabKey(file), false)"><span class="i-lucide-x" aria-hidden="true" /></button>
      </div>
    </MobileSheet>
    <MobileSheet v-if="mobileLayout" :open="actionsOpen" label="Conversation and document actions" :return-focus="mobileActionsButton" @update:open="actionsOpen = $event">
      <div class="mobile-workbench-actions">
        <slot name="actions" />
        <button v-if="explorerAvailable && !knowledgeSelected" @click="showMobileFiles"><span class="i-lucide-folder-open" aria-hidden="true" />Browse files</button>
        <button v-if="!isPermanentDocumentTab(tabs.selected)" @click="closeFile(tabs.selected); actionsOpen = false"><span class="i-lucide-x" aria-hidden="true" />Close current document</button>
        <button v-if="tabs.files.length > 1 || tabs.knowledge || tabs.projectTabs?.length" @click="tabs = closeAllFileTabs(tabs); actionsOpen = false">Close all documents</button>
        <slot name="mobile-actions" :close="closeMobileActions" />
      </div>
    </MobileSheet>
    <button v-if="expanded && !wide" class="explorer-backdrop" aria-label="Dismiss files" @click="collapseExplorer" />
    <aside v-if="explorerAvailable || (tabs.knowledge && knowledgeEnabled)" v-show="expanded" :id="`${id}-explorer`" class="workbench-explorer" :class="{ drawer: !wide }" :aria-label="knowledgeSelected ? 'Knowledge explorer' : 'File explorer'" @keydown.esc.stop.prevent="collapseExplorer">
      <FileTree v-if="explorerAvailable" v-show="!knowledgeSelected" :api-base="apiBase" :session-id="sessionId" :folder-id="folderId" tree-only :active="active && expanded && !knowledgeSelected"
        :remote="remote" :selected-path="selectedFilePath" :reveal-version="revealVersion"
        :git-status="gitStatus" :git-loading="gitLoading" :git-error="gitError" :git-offline="gitOffline" @refresh-git="refreshGit" @open="openFile">
        <template #actions>
          <HoverInfo text="Collapse files" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="workbench-button" aria-label="Collapse files" @click="collapseExplorer"><span class="i-lucide-panel-left-close" aria-hidden="true" /></button></HoverInfo>
        </template>
      </FileTree>
      <div v-if="tabs.knowledge && knowledgeEnabled" :id="`${id}-knowledge-sidebar`" v-show="knowledgeSelected" class="knowledge-explorer" />
      <SidebarResizer v-if="expanded && wide && active" class="files-resizer" :model-value="explorerWidth" :bounds="resizeBounds"
        :label="knowledgeSelected ? 'Resize Knowledge navigation' : 'Resize files'" :controls="`${id}-explorer`" @update:model-value="preferredWidth = $event" />
    </aside>
    <div class="workbench-editor">
      <Teleport :to="documentToolbarTarget || 'body'" :disabled="!documentToolbarTarget">
      <div v-show="!mobileLayout" class="document-toolbar" :class="{ 'shared-toolbar': documentToolbarTarget }">
        <HoverInfo v-if="explorerAvailable || knowledgeSelected" :text="knowledgeSelected ? 'Toggle Knowledge navigation (Ctrl+Shift+E)' : 'Toggle files (Ctrl+Shift+E)'" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" ref="explorerButton" class="workbench-button explorer-toggle" :aria-label="knowledgeSelected ? 'Toggle Knowledge navigation' : 'Toggle files'" aria-keyshortcuts="Control+Shift+E" :aria-controls="`${id}-explorer`" :aria-expanded="expanded" @click="toggleExplorer">
          <span class="i-lucide-panel-left" aria-hidden="true" />
        </button>
        </HoverInfo>
        <div class="document-tablist" role="tablist" aria-label="Open documents" @wheel="scrollTabs">
          <div v-if="!hidePrimaryTab" class="document-tab conversation-tab fixed-tab" :class="{ selected: tabs.selected === '' }" @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, '')">
            <button :id="tabId('')" role="tab" :aria-selected="tabs.selected === ''" :tabindex="tabs.selected === '' ? 0 : -1" :aria-controls="panelId('')" @click="selectTab('')" @keydown="tabKey($event, '')">
              <span class="document-icon" :class="primaryIcon" aria-hidden="true" /><span>{{ primaryLabel || 'Conversation' }}</span>
            </button>
          </div>
          <div v-if="tabs.diagnosis" class="document-tab diagnosis-tab fixed-tab" :class="{ selected: tabs.selected === DIAGNOSIS_TAB_KEY }" @mousedown="preventMiddleScroll">
            <button :id="tabId(DIAGNOSIS_TAB_KEY)" role="tab" :aria-selected="tabs.selected === DIAGNOSIS_TAB_KEY" :tabindex="tabs.selected === DIAGNOSIS_TAB_KEY ? 0 : -1"
              :aria-controls="panelId(DIAGNOSIS_TAB_KEY)" title="Session diagnosis" @click="selectTab(DIAGNOSIS_TAB_KEY)" @keydown="tabKey($event, DIAGNOSIS_TAB_KEY)">
              <span class="document-icon i-lucide-activity" aria-hidden="true" /><span>Diagnosis</span>
            </button>
          </div>
          <div ref="documentTabs" class="document-tabs">
          <div v-if="tabs.knowledge" class="document-tab" :class="{ selected: tabs.selected === KNOWLEDGE_TAB_KEY }"
            @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, KNOWLEDGE_TAB_KEY)" @contextmenu.prevent.stop="openTabMenu($event, KNOWLEDGE_TAB_KEY)">
            <button :id="tabId(KNOWLEDGE_TAB_KEY)" role="tab" :aria-selected="tabs.selected === KNOWLEDGE_TAB_KEY"
              :tabindex="tabs.selected === KNOWLEDGE_TAB_KEY ? 0 : -1" :aria-controls="panelId(KNOWLEDGE_TAB_KEY)"
              @click="selectTab(KNOWLEDGE_TAB_KEY)" @keydown="tabKey($event, KNOWLEDGE_TAB_KEY)">
              <span class="document-icon i-lucide-book-open" aria-hidden="true" /><span>Knowledge</span>
            </button>
            <button class="document-close" aria-label="Close Knowledge" @click="closeFile(KNOWLEDGE_TAB_KEY)"><span class="i-lucide-x" aria-hidden="true" /></button>
          </div>
          <div v-for="entryId in tabs.knowledgeEntries ?? []" :key="knowledgeEntryTabKey(entryId)" class="document-tab" :class="{ selected: tabs.selected === knowledgeEntryTabKey(entryId) }"
            @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, knowledgeEntryTabKey(entryId))" @contextmenu.prevent.stop="openTabMenu($event, knowledgeEntryTabKey(entryId))">
            <button :id="tabId(knowledgeEntryTabKey(entryId))" role="tab" :aria-selected="tabs.selected === knowledgeEntryTabKey(entryId)"
              :tabindex="tabs.selected === knowledgeEntryTabKey(entryId) ? 0 : -1" :aria-controls="panelId(knowledgeEntryTabKey(entryId))"
              :title="entryId" @click="selectTab(knowledgeEntryTabKey(entryId))" @keydown="tabKey($event, knowledgeEntryTabKey(entryId))">
              <span class="document-icon i-lucide-book-open" aria-hidden="true" /><span class="document-name">{{ knowledgeLabel(entryId) }}</span>
            </button>
            <button class="document-close" :aria-label="`Close ${knowledgeLabel(entryId)}`" @click="closeFile(knowledgeEntryTabKey(entryId))"><span class="i-lucide-x" aria-hidden="true" /></button>
          </div>
          <div v-for="tab in tabs.projectTabs ?? []" :key="tab" class="document-tab" :class="{ selected: tabs.selected === projectTabKey(tab) }"
            @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, projectTabKey(tab))" @contextmenu.prevent.stop="openTabMenu($event, projectTabKey(tab))">
            <button :id="tabId(projectTabKey(tab))" role="tab" :aria-selected="tabs.selected === projectTabKey(tab)"
              :tabindex="tabs.selected === projectTabKey(tab) ? 0 : -1" :aria-controls="panelId(projectTabKey(tab))"
              @click="selectTab(projectTabKey(tab))" @keydown="tabKey($event, projectTabKey(tab))">
              <span class="document-icon" :class="tab === 'settings' ? 'i-lucide-settings-2' : 'i-lucide-bot'" aria-hidden="true" /><span class="document-name">{{ tab === 'settings' ? 'Project settings' : 'Agents' }}</span>
            </button>
            <button class="document-close" :aria-label="`Close ${tab === 'settings' ? 'Project settings' : 'Agents'}`" @click="closeFile(projectTabKey(tab))"><span class="i-lucide-x" aria-hidden="true" /></button>
          </div>
          <div v-for="file in tabs.files" :key="fileTabKey(file)" class="document-tab" :class="{ selected: tabs.selected === fileTabKey(file) }" @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, fileTabKey(file))" @contextmenu.prevent.stop="openTabMenu($event, fileTabKey(file))">
            <HoverInfo :text="`${file.path}${file.view === 'diff' ? '\nChanges from HEAD' : ''}`" v-slot="{ triggerProps }">
            <button v-bind="triggerProps" :id="tabId(fileTabKey(file))" role="tab" :aria-selected="tabs.selected === fileTabKey(file)" :tabindex="tabs.selected === fileTabKey(file) ? 0 : -1" :aria-controls="panelId(fileTabKey(file))" :aria-label="`${file.path}${file.view === 'diff' ? ' changes' : ''}`" @click="selectTab(fileTabKey(file))" @keydown="tabKey($event, fileTabKey(file))">
              <span class="document-icon" :class="file.view === 'diff' ? 'i-lucide-file-diff' : fileIcon(file.entry.name)" aria-hidden="true" /><span class="document-name">{{ file.entry.name }}{{ file.view === 'diff' ? ' (changes)' : '' }}</span>
            </button>
            </HoverInfo>
            <HoverInfo :text="`Close ${file.entry.name}${file.view === 'diff' ? ' changes' : ''}`" v-slot="{ triggerProps }">
            <button v-bind="triggerProps" class="document-close" :aria-label="`Close ${file.path}${file.view === 'diff' ? ' changes' : ''}`" @click="closeFile(fileTabKey(file))"><span class="i-lucide-x" aria-hidden="true" /></button>
            </HoverInfo>
          </div>
          <Teleport to="body">
            <div v-if="tabMenu" class="document-menu-backdrop" @pointerdown.self="dismissTabMenu(true)" @contextmenu.prevent.self="dismissTabMenu(true)">
              <div ref="menuElement" class="document-menu" role="menu" aria-label="Document tab actions" :style="menuPosition" @keydown="menuKey">
                <button type="button" role="menuitem" @click="runTabAction('close')">Close</button>
                <button type="button" role="menuitem" :disabled="tabs.files.length + (tabs.knowledgeEntries?.length ?? 0) + (tabs.projectTabs?.length ?? 0) + Number(!!tabs.knowledge) < 2" @click="runTabAction('others')">Close others</button>
                <button type="button" role="menuitem" @click="runTabAction('all')"><span>Close all</span><span class="document-menu-shortcut">Ctrl+Shift+W</span></button>
              </div>
            </div>
          </Teleport>
          </div>
        </div>
        <slot name="actions" />
      </div>
      </Teleport>
      <div class="workbench-content" :class="{ 'draft-document': draft && tabs.selected === '' }">
        <div v-show="tabs.selected === ''" :id="panelId('')" class="conversation-document" role="tabpanel" :aria-labelledby="hidePrimaryTab ? conversationTabId : tabId('')">
          <slot :active="active && tabs.selected === ''" />
        </div>
        <div v-if="tabs.diagnosis" v-show="tabs.selected === DIAGNOSIS_TAB_KEY" :id="panelId(DIAGNOSIS_TAB_KEY)" class="diagnosis-document" role="tabpanel" :aria-labelledby="tabId(DIAGNOSIS_TAB_KEY)">
          <slot name="diagnosis" />
        </div>
        <div v-if="tabs.knowledge && knowledgeEnabled" v-show="knowledgeSelected"
          :id="panelId(knowledgeSelected ? tabs.selected : KNOWLEDGE_TAB_KEY)" class="knowledge-document" role="tabpanel" :aria-labelledby="tabId(knowledgeSelected ? tabs.selected : KNOWLEDGE_TAB_KEY)">
          <KnowledgeView :api-base="apiBase" :project-id="projectId ?? ''" :entry-id="knowledgeEntryId(tabs.selected) ?? ''"
            :sidebar-target="knowledgeSelected && expanded && wide ? `#${id}-knowledge-sidebar` : undefined"
            :active="active && knowledgeSelected" @select="selectKnowledgeEntry" @home="selectTab(KNOWLEDGE_TAB_KEY)" @catalog="updateKnowledgeLabels" />
        </div>
        <div v-if="tabs.knowledge && tabs.selected !== KNOWLEDGE_TAB_KEY" v-show="false" :id="panelId(KNOWLEDGE_TAB_KEY)"
          role="tabpanel" :aria-labelledby="tabId(KNOWLEDGE_TAB_KEY)" />
        <template v-for="entryId in tabs.knowledgeEntries ?? []" :key="`knowledge-panel:${entryId}`">
          <div v-if="tabs.selected !== knowledgeEntryTabKey(entryId)" v-show="false" :id="panelId(knowledgeEntryTabKey(entryId))"
            role="tabpanel" :aria-labelledby="tabId(knowledgeEntryTabKey(entryId))" />
        </template>
        <div v-if="tabs.projectTabs?.includes('settings')" v-show="tabs.selected === projectTabKey('settings')"
          :id="panelId(projectTabKey('settings'))" class="project-document" role="tabpanel" :aria-labelledby="tabId(projectTabKey('settings'))">
          <ProjectSettings :api-base="apiBase" :host-api-base="installation.apiBase" :project-id="projectId ?? ''" />
        </div>
        <div v-if="tabs.projectTabs?.includes('agents')" v-show="tabs.selected === projectTabKey('agents')"
          :id="panelId(projectTabKey('agents'))" class="project-document" role="tabpanel" :aria-labelledby="tabId(projectTabKey('agents'))">
          <div class="agents-document"><AgentsTab :api-base="apiBase" /></div>
        </div>
        <div v-for="file in tabs.files" v-show="tabs.selected === fileTabKey(file)" :id="panelId(fileTabKey(file))" :key="`${contextKey}:${fileTabKey(file)}`" class="file-document" role="tabpanel" :aria-labelledby="tabId(fileTabKey(file))">
          <FileDiffPreview v-if="(sessionId || folderId) && file.view === 'diff'" :api-base="apiBase" :session-id="sessionId" :folder-id="folderId"
            :path="file.path" :active="active && tabs.selected === fileTabKey(file)" :selection-active="keyboardActive && tabs.selected === fileTabKey(file)"
            :can-quote="canQuote" :revision="gitRevision" @quote="emit('quote', $event)" @open-source="openFile({ path: file.path, entry: file.entry })" />
          <FilePreviewModal v-else-if="sessionId || folderId" inline :api-base="apiBase" :session-id="sessionId" :folder-id="folderId"
            :remote="remote"
            :context-key="contextKey" @image-context="emit('image-context', $event)" @image-busy="emit('image-busy', $event)"
            :active="active && tabs.selected === fileTabKey(file)" :selection-active="keyboardActive && tabs.selected === fileTabKey(file)" :can-quote="canQuote"
            :entry="file.entry" :dir="file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''"
            @quote="emit('quote', $event)" @close="closeFile(fileTabKey(file))" />
        </div>
        <slot name="composer" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FileTree from './FileTree.vue'
import FilePreviewModal from './FilePreviewModal.vue'
import FileDiffPreview from './FileDiffPreview.vue'
import { isPermanentDocumentTab } from '../../file-workbench.ts'
import { useAutomationDocumentTabs } from '../../composables/useAutomationDocumentTabs.ts'
import { fileIcon } from '../../file-icons.ts'
import HoverInfo from '../HoverInfo.vue'
import KnowledgeView from '../KnowledgeView.vue'
import ProjectSettings from '../ProjectSettings.vue'
import AgentsTab from '../AgentsTab.vue'
import MobileSheet from '../MobileSheet.vue'
import { useMobileHeader } from '../../composables/useMobileChrome.ts'
import { useWorkdirGit } from '../../composables/useWorkdirGit.ts'
import SidebarResizer from '../SidebarResizer.vue'
import type { ImageContextBusy, ImageContextUpdate } from '../../image-context.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../../sidebar-resize.ts'
import { canCloseAllDocuments, canHandleDocumentShortcut, closeAllFileTabs, closeOtherFileTabs, closeFileTab, cycleDocumentTab, documentTabDirection, documentTabKeys, documentTabScrollLeft, fileTabKey, isCloseAllDocumentsKey, isCloseDocumentKey, isToggleExplorerKey, knowledgeHistoryDirection, KNOWLEDGE_TAB_KEY, DIAGNOSIS_TAB_KEY, withDiagnosisTab, nextDocumentTab, openFileTab, openKnowledgeTab, knowledgeEntryTabKey, knowledgeEntryId, projectTabKey, projectTabFromKey, openProjectTab, selectedFileToClose, type DocumentTabDirection, type FileTabs, type KnowledgeTabRequest, type OpenFile, type ProjectTab } from '../../file-workbench.ts'
import type { KnowledgeEntry } from '../../knowledge.ts'
import { useInstallationContext } from '../../composables/useInstallationContext.ts'

const props = withDefaults(defineProps<{ apiBase: string; sessionId: string; conversationTitle?: string; primaryLabel?: string; primaryIcon?: string; initialExplorerOpen?: boolean; projectNavigationEnabled?: boolean; folderId?: string; contextKey: string; active: boolean; keyboardActive?: boolean; explorerEnabled?: boolean; draft?: boolean; canQuote?: boolean; remote?: boolean; projectId?: string; knowledgeEnabled?: boolean; knowledgeRequest?: KnowledgeTabRequest; diagnosisEnabled?: boolean; diagnosisRequest?: boolean; documentToolbarTarget?: string; hidePrimaryTab?: boolean; conversationTabId?: string }>(), { primaryIcon: 'i-lucide-messages-square', initialExplorerOpen: undefined, projectNavigationEnabled: true, keyboardActive: true, explorerEnabled: true, draft: false, canQuote: false, remote: false, knowledgeEnabled: false, diagnosisEnabled: false, diagnosisRequest: undefined })
const router = useRouter()
const route = useRoute()
const installation = useInstallationContext()
const automationTabs = useAutomationDocumentTabs()
const emit = defineEmits<{ 'conversation-visible': [visible: boolean]; 'diagnosis-visible': [visible: boolean]; 'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab]; quote: [text: string]; 'image-context': [update: ImageContextUpdate]; 'image-busy': [update: ImageContextBusy] }>()
const id = `documents-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const root = ref<HTMLElement>()
const mobileHeader = useMobileHeader(() => props.active)
const mobileLayout = computed(() => !!mobileHeader.chrome?.enabled.value)
const mobileTitleButton = ref<HTMLButtonElement>()
const mobileActionsButton = ref<HTMLButtonElement>()
const viewsOpen = ref(false)
const actionsOpen = ref(false)
const documentTabs = ref<HTMLElement>()
const explorerButton = ref<HTMLButtonElement>()
const width = ref(0)
const preferredWidth = ref(220)
const resizeBounds = computed(() => sidebarWidthBounds(width.value, 180, 360))
const explorerWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const wide = computed(() => width.value >= 760)
const preference = ref<boolean | undefined>(props.initialExplorerOpen)
const remoteExpanded = ref(false)
const explorerAvailable = computed(() => props.explorerEnabled && !!(props.sessionId || props.folderId))
const knowledgeSelected = computed(() => props.knowledgeEnabled && (tabs.value.selected === KNOWLEDGE_TAB_KEY || !!knowledgeEntryId(tabs.value.selected)))
const knowledgeExpanded = ref(true)
const expanded = computed(() => knowledgeSelected.value
  ? wide.value && knowledgeExpanded.value
  : explorerAvailable.value && (props.remote ? remoteExpanded.value : (preference.value ?? wide.value)))
const tabs = ref<FileTabs>(withDiagnosisTab({ files: [], selected: '' }, props.diagnosisEnabled))
const knowledgeLabels = ref<Record<string, string>>({})
const knowledgeLabel = (entryId: string) => knowledgeLabels.value[entryId] ?? entryId.split('/').at(-1) ?? entryId
function updateKnowledgeLabels(entries: KnowledgeEntry[]) {
  knowledgeLabels.value = Object.fromEntries(entries.map(entry => [entry.id, entry.title]))
}
const selectedFilePath = computed(() => tabs.value.files.find(file => fileTabKey(file) === tabs.value.selected)?.path)
const revealVersion = ref(0)
const selectedTitle = computed(() => tabs.value.selected === DIAGNOSIS_TAB_KEY ? 'Diagnosis' : tabs.value.selected === KNOWLEDGE_TAB_KEY ? 'Knowledge'
  : tabs.value.selected === projectTabKey('settings') ? 'Project settings' : tabs.value.selected === projectTabKey('agents') ? 'Agents'
  : knowledgeEntryId(tabs.value.selected) ? knowledgeLabel(knowledgeEntryId(tabs.value.selected)!)
  : tabs.value.files.find(file => fileTabKey(file) === tabs.value.selected)?.entry.name
    ?? props.primaryLabel ?? props.conversationTitle ?? 'Conversation')
function closeMobileActions() { actionsOpen.value = false }
function chooseMobileView(key: string) { selectTab(key); viewsOpen.value = false }
function chooseMobileKnowledge() {
  tabs.value = openKnowledgeTab(tabs.value)
  viewsOpen.value = false
}
async function showMobileFiles() {
  actionsOpen.value = false
  if (props.remote) remoteExpanded.value = true
  else preference.value = true
  await nextTick()
  root.value?.querySelector<HTMLElement>('.workbench-explorer button')?.focus()
}
watch(() => [mobileHeader.visible.value, props.contextKey], () => {
  viewsOpen.value = false
  actionsOpen.value = false
})
const gitActive = computed(() => explorerAvailable.value && props.active && (!knowledgeSelected.value && expanded.value || tabs.value.files.some(file => file.view === 'diff' && fileTabKey(file) === tabs.value.selected)))
const { status: gitStatus, loading: gitLoading, error: gitError, offline: gitOffline, revision: gitRevision, refresh: refreshGit } = useWorkdirGit(
  () => ({ apiBase: props.apiBase, sessionId: props.sessionId, folderId: props.folderId }), gitActive)
const cachedTabs = new Map<string, FileTabs>()
const tabMenu = ref<{ key: string }>()
const menuElement = ref<HTMLElement>()
const menuPosition = ref({ left: '0px', top: '0px' })
let observer: ResizeObserver | undefined
let composing = false
const tabId = (path: string) => !path && props.hidePrimaryTab && props.conversationTabId
  ? props.conversationTabId : `${id}-tab-${encodeURIComponent(path)}`
const panelId = (path: string) => `${id}-panel-${encodeURIComponent(path)}`
function selectTab(path: string) {
  if (tabs.value.selected === path) return
  tabs.value = { ...tabs.value, selected: path }
}
defineExpose({
  showConversation: () => selectTab(''),
  showRunConversation: () => {
    selectTab('')
    preference.value = false
    remoteExpanded.value = false
  },
  openLinkedFile,
})
function openLinkedFile(file: OpenFile) {
  openFile(file)
  revealVersion.value++
  if (wide.value && explorerAvailable.value) {
    if (props.remote) remoteExpanded.value = true
    else preference.value = true
  }
}
function selectKnowledgeEntry(entryId: string) {
  if (tabs.value.knowledge) tabs.value = openKnowledgeTab(tabs.value, entryId)
}
function openFile(file: OpenFile) {
  tabs.value = openFileTab(tabs.value, file)
  if (!wide.value) { preference.value = false; remoteExpanded.value = false }
  void nextTick(() => {
    const tab = document.getElementById(tabId(fileTabKey(file)))
    ;(mobileLayout.value ? mobileTitleButton.value : tab)?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function closeFile(path: string, focusSelected = true) {
  tabs.value = closeFileTab(tabs.value, path)
  if (focusSelected) void nextTick(() => (mobileLayout.value ? mobileTitleButton.value : document.getElementById(tabId(tabs.value.selected)))?.focus({ preventScroll: true }))
}
function dismissTabMenu(restoreFocus = false) {
  const key = tabMenu.value?.key
  tabMenu.value = undefined
  if (restoreFocus && key !== undefined) document.getElementById(tabId(key))?.focus({ preventScroll: true })
}
async function openTabMenu(event: MouseEvent | KeyboardEvent, key: string) {
  if (!props.active || !props.keyboardActive || isPermanentDocumentTab(key) || !documentTabKeys(tabs.value).includes(key)) return
  const anchor = document.getElementById(tabId(key))?.getBoundingClientRect()
  if (!anchor) return
  const x = event instanceof MouseEvent && event.button === 2 ? event.clientX : anchor.left
  const y = event instanceof MouseEvent && event.button === 2 ? event.clientY : anchor.bottom
  tabMenu.value = { key }
  const menu = tabMenu.value
  menuPosition.value = { left: `${x}px`, top: `${y}px` }
  await nextTick()
  if (tabMenu.value !== menu || !menuElement.value) return
  const bounds = menuElement.value.getBoundingClientRect()
  menuPosition.value = {
    left: `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`,
  }
  menuElement.value.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
}
function runTabAction(action: 'close' | 'others' | 'all') {
  const key = tabMenu.value?.key
  if (key === undefined) return
  dismissTabMenu()
  if (action === 'close') return closeFile(key)
  tabs.value = action === 'all' ? closeAllFileTabs(tabs.value) : closeOtherFileTabs(tabs.value, key)
  void nextTick(() => document.getElementById(tabId(tabs.value.selected))?.focus({ preventScroll: true }))
}
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    dismissTabMenu(true)
    return
  }
  const buttons = Array.from(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = nextDocumentTab(buttons.map((_, i) => String(i)), String(index),
    event.key === 'ArrowDown' ? 'ArrowRight' : event.key === 'ArrowUp' ? 'ArrowLeft' : event.key)
  if (next === undefined) return
  event.preventDefault()
  buttons[Number(next)]?.focus()
}
function dismissMenuOnWindowChange() { dismissTabMenu() }
function preventMiddleScroll(event: MouseEvent) {
  if (event.button === 1) event.preventDefault()
}
function middleClickTab(event: MouseEvent, path: string) {
  if (event.button !== 1) return
  event.preventDefault()
  if (!isPermanentDocumentTab(path)) closeFile(path, tabs.value.selected === path)
}
function scrollTabs(event: WheelEvent) {
  const strip = documentTabs.value
  if (!strip) return
  const next = documentTabScrollLeft(event, strip)
  if (next === undefined) return
  event.preventDefault()
  strip.scrollLeft = next
}
function tabKey(event: KeyboardEvent, path: string) {
  if (!isPermanentDocumentTab(path) && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
    event.preventDefault()
    void openTabMenu(event, path)
    return
  }
  if (event.key === 'Delete' && !isPermanentDocumentTab(path)) { event.preventDefault(); closeFile(path); return }
  const next = nextDocumentTab(documentTabKeys(tabs.value), path, event.key)
  if (next === undefined) return
  event.preventDefault()
  selectTab(next)
  void nextTick(() => {
    const tab = document.getElementById(tabId(next))
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function shortcutContext() {
  const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], dialog[open], [popover]:popover-open, .folder-dialog-backdrop, .folder-menu-backdrop, .composer-popover-backdrop',
  )).some(element => element.getClientRects().length > 0
    && (!element.classList.contains('hover-info-popup') || element.contains(document.activeElement)))
  return {
    active: props.active,
    keyboardActive: props.keyboardActive,
    visible: !!root.value?.getClientRects().length,
    explorerEnabled: props.explorerEnabled || !!tabs.value.knowledge || !!tabs.value.diagnosis,
    overlayOpen,
    composing,
  }
}
function closeCurrentFile(): boolean {
  const key = selectedFileToClose(tabs.value, shortcutContext())
  if (key === undefined) return false
  closeFile(key)
  return true
}
function closeAllDocuments(): boolean {
  if (!canCloseAllDocuments(tabs.value, shortcutContext())) return false
  tabs.value = closeAllFileTabs(tabs.value)
  void nextTick(() => document.getElementById(tabId(tabs.value.selected))?.focus({ preventScroll: true }))
  return true
}
function cycleTab(direction: DocumentTabDirection): boolean {
  const next = cycleDocumentTab(tabs.value, direction, shortcutContext())
  if (next === undefined) return false
  selectTab(next)
  void nextTick(() => {
    const tab = document.getElementById(tabId(next))
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return true
}
function toggleExplorerShortcut(): boolean {
  if (!(explorerAvailable.value || knowledgeSelected.value) || !canHandleDocumentShortcut(shortcutContext())) return false
  if (expanded.value && root.value?.querySelector('.workbench-explorer')?.contains(document.activeElement)) collapseExplorer()
  else toggleExplorer()
  return true
}
function documentKey(event: KeyboardEvent) {
  const historyDirection = knowledgeHistoryDirection(event)
  if (historyDirection !== undefined && knowledgeSelected.value && canHandleDocumentShortcut(shortcutContext())) {
    event.preventDefault()
    router.go(historyDirection)
    return
  }
  if (isToggleExplorerKey(event) && toggleExplorerShortcut()) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (isCloseAllDocumentsKey(event) && closeAllDocuments()) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  if (isCloseDocumentKey(event) && closeCurrentFile()) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  const direction = documentTabDirection(event)
  if (direction === undefined || !cycleTab(direction)) return
  event.preventDefault()
  event.stopPropagation()
}
function nativeDocumentKey(event: Event) {
  const direction: unknown = (event as CustomEvent).detail
  if (direction === 'close') closeCurrentFile()
  else if (direction === 'close-all') closeAllDocuments()
  else if (direction === 'toggle-explorer') toggleExplorerShortcut()
  else if (direction === -1 || direction === 1) cycleTab(direction)
}
function compositionStart() { composing = true }
function compositionEnd() { composing = false }
function collapseExplorer() {
  if (knowledgeSelected.value) knowledgeExpanded.value = false
  else if (props.remote) remoteExpanded.value = false
  else preference.value = false
  ;(mobileLayout.value ? mobileActionsButton.value : explorerButton.value)?.focus({ preventScroll: true })
}
function toggleExplorer() {
  if (knowledgeSelected.value) knowledgeExpanded.value = !knowledgeExpanded.value
  else if (props.remote) remoteExpanded.value = !expanded.value
  else preference.value = !expanded.value
}
function measureWidth() {
  if (root.value?.getClientRects().length) width.value = root.value.getBoundingClientRect().width
}
watch(() => [props.contextKey, props.diagnosisEnabled] as const, ([key, diagnosis], [previous]) => {
  dismissTabMenu()
  remoteExpanded.value = false
  if (key !== previous) {
    cachedTabs.set(previous, tabs.value)
    tabs.value = cachedTabs.get(key) ?? { files: [], selected: '' }
  }
  tabs.value = withDiagnosisTab(tabs.value, diagnosis)
})
watch(() => [props.knowledgeRequest, props.contextKey, props.knowledgeEnabled], () => {
  if (!props.knowledgeEnabled) {
    tabs.value = closeFileTab(tabs.value, KNOWLEDGE_TAB_KEY)
  } else if (props.knowledgeRequest) {
    tabs.value = openKnowledgeTab(tabs.value, props.knowledgeRequest.entryId)
  } else if (knowledgeSelected.value) {
    selectTab('')
  }
}, { immediate: true })
watch(() => [route?.name, route?.params?.projectId, props.active, props.projectId, props.contextKey], () => {
  if (!props.projectNavigationEnabled || !props.active || !props.projectId || route?.params?.projectId !== props.projectId) return
  const tab = route?.name === 'project-settings' ? 'settings' : route?.name === 'agents' ? 'agents' : undefined
  if (tab && installation.value.uiScopes.includes('main:admin')) tabs.value = openProjectTab(tabs.value, tab)
  else if (projectTabFromKey(tabs.value.selected)) selectTab('')
}, { immediate: true })
watch(() => [props.apiBase, props.contextKey], () => { knowledgeLabels.value = {} })
watch(() => props.active && props.keyboardActive, active => { if (!active) dismissTabMenu() })
watch(() => [props.diagnosisRequest, props.contextKey, props.diagnosisEnabled], () => {
  if (props.diagnosisRequest && props.diagnosisEnabled) selectTab(DIAGNOSIS_TAB_KEY)
  else if (props.diagnosisRequest === false && tabs.value.selected === DIAGNOSIS_TAB_KEY) selectTab('')
}, { immediate: true })
watch(() => tabs.value.selected === '', value => emit('conversation-visible', value), { immediate: true, flush: 'sync' })
watch(() => [props.active, props.hidePrimaryTab, tabs.value.selected] as const, ([active, hidden, key]) => {
  if (active && hidden) {
    automationTabs?.selectDocument(props.sessionId, key)
    void nextTick(() => {
      const tab = document.getElementById(tabId(key))
      if (tab?.getClientRects().length) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
}, { immediate: true, flush: 'sync' })
watch(() => [props.contextKey, tabs.value.selected === DIAGNOSIS_TAB_KEY] as const,
  ([, value]) => emit('diagnosis-visible', value), { immediate: true, flush: 'sync' })
watch(() => [knowledgeSelected.value, knowledgeEntryId(tabs.value.selected)] as const,
  ([active, entryId]) => emit('knowledge-navigation', active, entryId), { immediate: true })
watch(() => [tabs.value.selected, props.active] as const, ([selected]) => {
  if (props.projectNavigationEnabled && props.active && props.projectId && route?.params?.projectId === props.projectId && !knowledgeSelected.value) {
    emit('project-navigation', projectTabFromKey(selected))
  }
})
onMounted(() => {
  // Check overlays before a target's Tab handler can dismiss them.
  document.addEventListener('keydown', documentKey, true)
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  window.addEventListener('blur', compositionEnd)
  window.addEventListener('blur', dismissMenuOnWindowChange)
  window.addEventListener('resize', dismissMenuOnWindowChange)
  window.addEventListener('shadow:cycle-document-tab', nativeDocumentKey)
  measureWidth()
  observer = new ResizeObserver(measureWidth)
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => {
  observer?.disconnect()
  document.removeEventListener('keydown', documentKey, true)
  document.removeEventListener('compositionstart', compositionStart, true)
  document.removeEventListener('compositionend', compositionEnd, true)
  window.removeEventListener('blur', compositionEnd)
  window.removeEventListener('blur', dismissMenuOnWindowChange)
  window.removeEventListener('resize', dismissMenuOnWindowChange)
  window.removeEventListener('shadow:cycle-document-tab', nativeDocumentKey)
})
</script>

<style scoped>
.file-workbench { display: flex; position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; height: 100%; }
.mobile-document-title { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; min-height: 44px; border: 0; padding: 0 4px; background: transparent; color: var(--c-text); font: inherit; font-size: 15px; font-weight: 600; line-height: 1.5; text-align: left; }
.mobile-document-title > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-document-title > span:last-child { flex-shrink: 0; }
.mobile-document-more { display: grid; place-items: center; flex: 0 0 44px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--c-text); }
.mobile-document-title:focus-visible, .mobile-document-more:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-view-row { display: flex; min-width: 0; }
.mobile-view-row button, .mobile-workbench-actions :deep(button) { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; min-height: 44px; padding: 10px 12px; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 14px; text-align: left; }
.mobile-view-row button > span:first-child { flex-shrink: 0; }
.mobile-view-row button > span:last-child { overflow-wrap: anywhere; }
.mobile-view-row button[aria-current="page"] { background: var(--c-selection-bg); color: var(--c-primary); }
.mobile-view-row .mobile-view-close { flex: 0 0 44px; justify-content: center; padding: 0; }
.mobile-workbench-actions { display: flex; flex-direction: column; }
.mobile-view-row button:focus-visible, .mobile-workbench-actions :deep(button:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-workbench .workbench-explorer.drawer, .mobile-workbench .explorer-backdrop { top: 0; }
.workbench-explorer { position: relative; display: flex; flex: 0 0 var(--explorer-width, 220px); min-width: 0; min-height: 0; box-sizing: border-box; border-right: 1px solid var(--c-border); background: var(--c-bg-card); }
.knowledge-explorer { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-editor { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.workbench-content { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-content.draft-document { justify-content: safe center; overflow-y: auto; padding: 40px 0 80px; box-sizing: border-box; }
.draft-document > .conversation-document { flex: 0 0 auto; overflow: visible; }
.document-toolbar { display: flex; align-items: stretch; flex: 0 0 var(--document-toolbar-height, 40px); min-width: 0; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.document-toolbar.shared-toolbar { flex: 1; min-width: max-content; border-bottom: 0; }
.shared-toolbar .document-tablist, .shared-toolbar .document-tabs { flex: 0 0 auto; overflow: visible; }
.document-tablist { display: flex; flex: 1; min-width: 0; }
.document-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; }
.fixed-tab { flex: 0 1 auto; }
.fixed-tab [role="tab"] { min-height: 40px; }
.fixed-tab [role="tab"] > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-menu-backdrop { position: fixed; inset: 0; z-index: 900; }
.document-menu { position: fixed; display: flex; flex-direction: column; width: 268px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto; box-sizing: border-box; padding: 5px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.document-menu button { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; padding: 8px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.document-menu button:hover:not(:disabled), .document-menu button:focus-visible { background: var(--c-bg-muted); }
.document-menu button:disabled { color: var(--c-text-secondary); opacity: .5; cursor: default; }
.document-menu-shortcut { color: var(--c-text-secondary); font-size: 12px; white-space: nowrap; }
.document-tab { display: flex; flex-shrink: 0; min-width: 0; max-width: 240px; border-right: 1px solid var(--c-border); color: var(--c-text-secondary); }
.document-tab.selected { background: var(--c-bg); color: var(--c-text); box-shadow: inset 0 2px var(--c-blue); }
.document-tab [role="tab"] { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 12px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.document-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-icon { flex: 0 0 16px; width: 16px; height: 16px; }
.workbench-button, .document-close { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 32px; align-self: center; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.explorer-toggle { width: 36px; height: 36px; margin: 2px; }
.workbench-button > span, .document-close > span { display: block; width: 16px; height: 16px; }
.document-close { margin-right: 4px; }
button:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.conversation-document, .diagnosis-document, .file-document, .knowledge-document, .project-document { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.project-document { overflow-y: auto; }
.agents-document { width: 100%; max-width: 1240px; margin: 0 auto; padding: 28px 24px 48px; box-sizing: border-box; }
.workbench-explorer.drawer { position: absolute; inset: calc(var(--document-toolbar-height, 40px) + 1px + var(--workbench-top-offset, 0px)) auto 0 0; width: min(260px, calc(100% - 32px)); z-index: 9; box-shadow: 8px 0 24px var(--c-shadow-soft); }
.explorer-backdrop { position: absolute; inset: calc(var(--document-toolbar-height, 40px) + 1px + var(--workbench-top-offset, 0px)) 0 0; border: 0; padding: 0; z-index: 8; background: rgb(0 0 0 / 20%); }
@media (max-width: 700px) {
  .document-menu button { min-height: 44px; }
  .workbench-content.draft-document { padding: 58px 0 28px; }
}
@media (pointer: coarse) {
  .file-workbench { --document-toolbar-height: 44px; }
  .fixed-tab [role="tab"] { min-height: 44px; }
}
</style>
