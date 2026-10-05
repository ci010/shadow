import { inject, type InjectionKey } from 'vue'

export const automationDocumentTabsKey: InjectionKey<{ selectDocument(sessionId: string, key: string): void }> = Symbol('automation-document-tabs')
export function useAutomationDocumentTabs() { return inject(automationDocumentTabsKey, undefined) }
