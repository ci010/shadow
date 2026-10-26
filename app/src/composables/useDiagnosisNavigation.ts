import { t } from '../i18n.ts'
import { computed, ref, watch } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'

export type DiagnosisSection = 'trace' | 'prompt' | 'tools' | 'stats'
export function diagnosisSection(value: unknown): DiagnosisSection {
  return value === 'prompt' || value === 'tools' || value === 'stats' ? value : 'trace'
}

export function useDiagnosisNavigation(options: {
  route: RouteLocationNormalizedLoaded
  router: Pick<Router, 'replace'>
  projectId: () => string
  sessionId: () => string
  embedded: () => boolean
}) {
  const { route, router } = options
  const section = ref<DiagnosisSection>('trace')
  const error = ref('')
  const panelKey = computed(() => options.embedded() ? 'childPanel' : 'panel')
  const sectionKey = computed(() => options.embedded() ? 'childDiagnosis' : 'diagnosis')
  const ownsRoute = computed(() => route.name === 'chat' && route.params.projectId === options.projectId()
    && !!options.sessionId() && (options.embedded() ? route.query.child : route.params.sessionId) === options.sessionId())
  const requested = computed(() => ownsRoute.value ? route.query[panelKey.value] === 'diagnosis' : undefined)
  watch(() => [ownsRoute.value, route.query[panelKey.value], route.query[sectionKey.value]], () => {
    if (requested.value) section.value = diagnosisSection(route.query[sectionKey.value])
  }, { immediate: true, flush: 'sync' })

  function selectPanel(active: boolean, conversationVisible = true) {
    // Hiding diagnosis for another document (notably Project settings) must
    // not start a query-only replacement that cancels that document's navigation.
    if (!active && !conversationVisible) return
    if (!ownsRoute.value) return
    const query = { ...route.query }
    if (active) {
      query[panelKey.value] = 'diagnosis'
      query[sectionKey.value] = section.value
      if (!options.embedded()) delete query.entry
    } else {
      if (query[panelKey.value] !== 'diagnosis') return
      delete query[panelKey.value]
      delete query[sectionKey.value]
    }
    if (query[panelKey.value] === route.query[panelKey.value] && query[sectionKey.value] === route.query[sectionKey.value]) return
    void router.replace({ query }).then(() => { error.value = '' }, cause => {
      error.value = t('Could not save the diagnosis view in the URL. {value1}', { value1: cause instanceof Error ? cause.message : String(cause) })
    })
  }
  function selectSection(value: DiagnosisSection) {
    section.value = value
    selectPanel(true)
  }
  return { requested, section, error, selectPanel, selectSection }
}
