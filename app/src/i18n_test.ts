import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { afterEach } from 'node:test'
import { computed, nextTick } from 'vue'
import {
  formatDateTime, formatNumber, i18n, initializeI18n, isLocalePreference, localePersistenceError,
  localePreference, LOCALE_STORAGE_KEY, resolveLocale, setLocalePreference, t,
} from './i18n.ts'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import { channelDefinitions } from './channel-settings.ts'
import { navigationFor } from './navigation-policy.ts'
import { enumLabel } from './display-labels.ts'
import { formatTokenCount } from './session-details.ts'
import { messageTime } from './message-history.ts'
import { parseSessionMessage } from './message-author.ts'
import { groupToolActivity } from './tool-activity.ts'
import { subagentActivityLabel } from './subagent-executions.ts'
import { browserIoCapabilities } from './io/adapters.ts'
import { installMobileCaptureRestriction } from './io/mobile-policy.ts'
import { AnnotationLoadError, annotationLoadErrorMessage, annotationSizeError, MAX_ANNOTATION_BYTES } from './image-annotation.ts'

function browser(languages = ['en-US'], stored?: string) {
  const values = new Map(stored === undefined ? [] : [[LOCALE_STORAGE_KEY, stored]])
  const writes: string[][] = []
  const events = new EventTarget()
  return Object.assign(events, {
    navigator: { languages },
    document: { documentElement: { lang: '' } },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) { values.set(key, value); writes.push([key, value]) },
    },
    values, writes,
    storage(key: string | null, newValue: string | null, storageArea: unknown = null) {
      events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea }))
    },
  })
}

afterEach(() => setLocalePreference('en'))

test('locale resolution respects explicit choices and browser language priority', () => {
  assert.equal(resolveLocale('en', ['zh-CN']), 'en')
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN')
  for (const language of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'ZH_cn']) {
    assert.equal(resolveLocale('system', [language]), 'zh-CN')
  }
  assert.equal(resolveLocale('system', ['en-GB', 'zh-CN']), 'en')
  assert.equal(resolveLocale('system', ['de', 'zh-CN', 'en-US']), 'zh-CN')
  for (const value of [null, undefined, 'bad', '{"locale":"en"}']) {
    assert.equal(resolveLocale(value, ['zh-CN']), 'zh-CN')
    assert.equal(isLocalePreference(value), false)
  }
  assert.equal(resolveLocale('system', ['fr']), 'en')
  assert.equal(resolveLocale('system', []), 'en')
  for (const value of ['system', 'en', 'zh-CN']) assert.equal(isLocalePreference(value), true)
})

test('preferences apply before rendering, persist across reload, follow system changes, and clean up', async () => {
  const host = browser(['zh-CN'])
  const dispose = initializeI18n(host)
  try {
    assert.equal(localePreference.value, 'system')
    assert.equal(host.document.documentElement.lang, 'zh-CN')
    assert.equal(t('Language'), '语言')
    setLocalePreference('en')
    assert.equal(host.document.documentElement.lang, 'en')
    assert.deepEqual(host.writes, [[LOCALE_STORAGE_KEY, 'en']])
    host.navigator.languages = ['zh-TW']
    host.dispatchEvent(new Event('languagechange'))
    assert.equal(i18n.global.locale.value, 'en')
    setLocalePreference('system')
    assert.equal(i18n.global.locale.value, 'zh-CN')
    host.navigator.languages = ['en-GB']
    host.dispatchEvent(new Event('languagechange'))
    assert.equal(i18n.global.locale.value, 'en')
    setLocalePreference('zh-CN')
  } finally { dispose() }
  const reload = initializeI18n(host)
  assert.equal(localePreference.value, 'zh-CN')
  assert.equal(host.document.documentElement.lang, 'zh-CN')
  reload()
  host.storage(LOCALE_STORAGE_KEY, 'en')
  host.navigator.languages = ['en']
  host.dispatchEvent(new Event('languagechange'))
  assert.equal(i18n.global.locale.value, 'zh-CN')
  setLocalePreference('en')
  await nextTick()
  assert.equal(host.document.documentElement.lang, 'zh-CN', 'The document watcher is disposed')
})

test('other tabs synchronize preferences without writes and unrelated storage is ignored', () => {
  const host = browser(['zh-CN'], 'en')
  const dispose = initializeI18n(host)
  try {
    host.storage('unrelated', 'zh-CN')
    host.storage(LOCALE_STORAGE_KEY, 'zh-CN', {})
    assert.equal(i18n.global.locale.value, 'en')
    host.storage(LOCALE_STORAGE_KEY, 'zh-CN', host.localStorage)
    assert.equal(localePreference.value, 'zh-CN')
    host.storage(LOCALE_STORAGE_KEY, 'unsupported')
    assert.equal(localePreference.value, 'system')
    host.storage(LOCALE_STORAGE_KEY, 'en')
    host.storage(null, null)
    assert.equal(localePreference.value, 'system')
    assert.equal(host.document.documentElement.lang, 'zh-CN')
    assert.deepEqual(host.writes, [])
  } finally { dispose() }
})

test('unavailable storage reports the failure but language switching still works', context => {
  const warning = context.mock.method(console, 'warn', () => {})
  const host = browser(['zh-CN'])
  Object.defineProperty(host, 'localStorage', {
    configurable: true, get() { throw new DOMException('Synthetic blocked storage', 'SecurityError') },
  })
  const dispose = initializeI18n(host)
  try {
    assert.equal(localePersistenceError.value, true)
    assert.equal(i18n.global.locale.value, 'zh-CN')
    setLocalePreference('en')
    assert.equal(i18n.global.locale.value, 'en')
    assert.equal(host.document.documentElement.lang, 'en')
    assert.equal(localePersistenceError.value, true)
    assert.equal(warning.mock.callCount(), 2)
  } finally { dispose() }
  const recovered = initializeI18n(browser())
  assert.equal(localePersistenceError.value, false)
  recovered()
})

test('catalogs have identical keys and placeholders, and every message compiles in both languages', context => {
  const warnings = context.mock.method(console, 'warn', () => {})
  const errors = context.mock.method(console, 'error', () => {})
  for (const locale of ['en', 'zh-CN']) {
    const source = readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), 'utf8')
    const keys = [...source.matchAll(/^  ("(?:[^"\\]|\\.)*"):/gm)].map(match => JSON.parse(match[1]!))
    assert.equal(new Set(keys).size, keys.length, `${locale}: duplicate message key`)
  }
  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort())
  const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort()
  for (const [key, value] of Object.entries(en)) {
    const chinese: unknown = Reflect.get(zhCN, key)
    assert.equal(typeof chinese, 'string', key)
    assert.ok(typeof chinese === 'string' && chinese.trim(), key)
    assert.deepEqual(placeholders(chinese), placeholders(value), key)
    const parameters = Object.fromEntries(placeholders(value).map(name => [name, name === 'count' ? 2 : `fixture-${name}`]))
    for (const locale of ['en', 'zh-CN'] as const) {
      setLocalePreference(locale)
      assert.equal(typeof i18n.global.t(key, parameters, 2), 'string', `${locale}: ${key}`)
    }
  }
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), [])
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [])
})

test('English fallback, literal source keys, interpolation, and count-based plurals work', context => {
  context.mock.method(console, 'warn', () => {})
  setLocalePreference('en')
  assert.equal(t('Message from {senderName}', { senderName: 'Alice@home | {root}' }), 'Message from Alice@home | {root}')
  assert.equal(t('{count} agents', { count: 1 }, 1), '1 agent')
  assert.equal(t('{count} agents', { count: 2 }, 2), '2 agents')
  setLocalePreference('zh-CN')
  assert.equal(t('{count} agents', { count: 0 }, 0), '0 个智能体')
  assert.equal(t('{count} agents', { count: 2 }, 2), '2 个智能体')
  assert.equal(t('Jump to message {number}', { number: 3 }), '跳转到第 3 条消息')
  assert.equal(t('Stable name'), '固定名称')
  const source = i18n.global.getLocaleMessage('zh-CN')
  const saved = source.Retry
  try {
    Reflect.deleteProperty(source, 'Retry')
    assert.equal(t('Retry'), 'Retry')
  } finally { source.Retry = saved }
  assert.equal(t('Retry'), zhCN.Retry)
  assert.equal(subagentActivityLabel({ running: 2, pending: 1, waiting: 0 }), '2 个子智能体正在工作, 1 个子智能体待处理')
})

test('computed metadata, numbers, dates, and enum labels update without reloading', () => {
  const navigation = computed(() => navigationFor({ mode: 'main', uiScopes: ['main:admin', 'chat:read'] }))
  const fieldLabel = computed(() => channelDefinitions[0]!.fields[0]!.label)
  const count = computed(() => formatTokenCount(12_345))
  const date = new Date('2026-07-09T12:34:00Z')
  const dateLabel = computed(() => formatDateTime(date, { year: 'numeric', month: 'long', timeZone: 'UTC' }))
  setLocalePreference('en')
  const before = { label: fieldLabel.value, nav: navigation.value, date: dateLabel.value }
  assert.equal(count.value, '12.3K')
  assert.equal(formatNumber(1234), '1,234')
  assert.equal(enumLabel('pending'), 'pending')
  setLocalePreference('zh-CN')
  assert.equal(count.value, '12.3K')
  assert.notEqual(fieldLabel.value, before.label)
  assert.notDeepEqual(navigation.value.map(item => item.label), before.nav.map(item => item.label))
  assert.deepEqual(navigation.value.map(item => item.name), before.nav.map(item => item.name))
  assert.equal(dateLabel.value, '2026年7月')
  assert.notEqual(dateLabel.value, before.date)
  assert.equal(enumLabel('pending'), '待处理')
  assert.equal(enumLabel('custom-server-value'), 'custom-server-value')
  assert.equal(enumLabel('constructor'), 'constructor')
  assert.equal(messageTime(date.toISOString()).title, new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'long' }).format(date))
  assert.equal(messageTime(date.toISOString(), 'en-GB').title, new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'long' }).format(date))
  assert.equal(formatDateTime('invalid-date'), t('Time unavailable'))
})

test('localization does not translate user content, session IDs, tool arguments, or capability IDs', () => {
  setLocalePreference('zh-CN')
  const content = 'Retry <sender source="user" /> User-authored English and 中文.'
  const original = { role: 'user', content: '<sender id="web:worker" source="session" intent="handoff" />' + content }
  const parsed = parseSessionMessage(original)!
  assert.equal(parsed.content, content)
  assert.equal(parsed.sessionSource.id, 'web:worker')
  assert.equal(parsed.sessionSource.intent, 'handoff')
  assert.equal(original.role, 'user')
  const args = { path: 'C:\\fixture\\Retry.txt', flag: 'n' }
  const tool = groupToolActivity([{ event: 'tool_call', content: '', toolCallId: 'read-1', toolCall: { name: 'read', arguments: args } }]).get(0)!.entries[0]!
  assert.equal(tool.name, 'read')
  assert.equal(tool.toolCallId, 'read-1')
  assert.equal(tool.path, args.path)
  assert.deepEqual(JSON.parse(tool.arguments), args)
  const restore = installMobileCaptureRestriction()
  try {
    const capabilities = browserIoCapabilities()
    assert.deepEqual(capabilities.map(item => item.id), ['microphone', 'camera', 'screen', 'file', 'form'])
    assert.match(capabilities[0]!.reason!, /摄像头|摄像|相机/)
  } finally { restore() }
})

test('image errors are classified by type rather than words in their translated messages', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    setLocalePreference(locale)
    const message = annotationSizeError(MAX_ANNOTATION_BYTES + 1)!
    assert.equal(annotationLoadErrorMessage(new AnnotationLoadError(message)), message)
    assert.match(message, /20 MiB/)
    const httpError = t('Image request failed (HTTP {status}). Retry or open the raw image.', { status: 503 })
    assert.equal(annotationLoadErrorMessage(new AnnotationLoadError(httpError)), httpError)
    assert.equal(annotationLoadErrorMessage(new Error('arbitrary image decoder detail')),
      t('This image could not be decoded safely. Retry or open the raw image.'))
  }
})
