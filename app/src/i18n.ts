import { readonly, ref, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

export type Locale = 'en' | 'zh-CN'
export type LocalePreference = Locale | 'system'
export type MessageKey = keyof typeof en
export const LOCALE_STORAGE_KEY = 'shadow.locale'

export const i18n = createI18n({
  legacy: false,
  locale: 'en' as Locale,
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN },
  // Source-text keys are literal, including punctuation and interpolation braces.
  messageResolver: (messages, key) => Object.prototype.hasOwnProperty.call(messages, key)
    ? (messages as Record<string, string>)[key]! : null,
})

const preference = ref<LocalePreference>('system')
const persistenceError = ref(false)
export const localePreference = readonly(preference)
export const localePersistenceError = readonly(persistenceError)
export type LocalizationHost = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  navigator: Pick<Navigator, 'languages'>
  document: { documentElement: { lang: string } }
  localStorage: Pick<Storage, 'getItem' | 'setItem'>
}

let host: LocalizationHost | undefined
let systemLanguages: readonly string[] = []

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || value === 'en' || value === 'zh-CN'
}

export function resolveLocale(value: unknown, languages: readonly string[] = []): Locale {
  if (value === 'en' || value === 'zh-CN') return value
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0]
    if (base === 'zh') return 'zh-CN'
    if (base === 'en') return 'en'
  }
  return 'en'
}

export function t(message: MessageKey, values: Record<string, unknown> = {}, count?: number): string {
  return count === undefined ? i18n.global.t(message, values) : i18n.global.t(message, values, count)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(i18n.global.locale.value, options).format(value)
}

export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (!Number.isFinite(date instanceof Date ? date.getTime() : date)) return t('Time unavailable')
  return new Intl.DateTimeFormat(i18n.global.locale.value, options ?? {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date)
}

function applyPreference(value: unknown) {
  preference.value = isLocalePreference(value) ? value : 'system'
  i18n.global.locale.value = resolveLocale(preference.value, systemLanguages)
}

export function setLocalePreference(value: LocalePreference): void {
  applyPreference(value)
  try {
    host?.localStorage.setItem(LOCALE_STORAGE_KEY, value)
    persistenceError.value = false
  } catch (error) {
    persistenceError.value = true
    console.warn('[i18n] Could not save the language preference.', error)
  }
}

export function initializeI18n(window: LocalizationHost): () => void {
  host = window
  systemLanguages = window.navigator.languages
  let storage: LocalizationHost['localStorage'] | undefined
  try {
    storage = window.localStorage
    applyPreference(storage.getItem(LOCALE_STORAGE_KEY))
    persistenceError.value = false
  } catch (error) {
    persistenceError.value = true
    applyPreference('system')
    console.warn('[i18n] Could not read the language preference.', error)
  }
  const stop = watch(i18n.global.locale, locale => {
    window.document.documentElement.lang = locale
  }, { immediate: true, flush: 'sync' })
  const languageChanged = () => {
    systemLanguages = window.navigator.languages
    if (preference.value === 'system') applyPreference('system')
  }
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea !== null && event.storageArea !== storage) return
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) applyPreference(event.newValue)
  }
  window.addEventListener('languagechange', languageChanged)
  window.addEventListener('storage', storageChanged)
  return () => {
    stop()
    window.removeEventListener('languagechange', languageChanged)
    window.removeEventListener('storage', storageChanged)
    if (host === window) host = undefined
  }
}
