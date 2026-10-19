# Frontend localization

The browser, Electron renderer, and mobile client support English and Simplified
Chinese. Use the language selector in the window header, mobile navigation, or
**App settings > Language**. It is also available before login and during desktop
setup. See [language preferences](using-shadow.md#language) for storage and
system-language behavior.

Frontend copy uses Vue I18n through the typed `t()` helper in
`app/src/i18n.ts`. Add the same literal English source key to
`app/src/locales/en.json` and `app/src/locales/zh-CN.json`, then call `t()` from
rendering, a computed value, or a metadata getter so language changes remain
reactive. Do not eagerly translate module constants or default props.

Translate complete messages with named placeholders rather than concatenating
words or adding English plural suffixes. For example,
`t('{count} agents', { count }, count)` uses the English catalog value
`{count} agent | {count} agents` and the Chinese value `{count} 个智能体`.
Vue I18n reserves `@`, braces, and `|`; use its literal interpolation syntax for
literal special characters, such as `{'@'}`, and reserve unescaped `|` for plurals.
Use `formatNumber()` / `formatDateTime()` for presentation and `enumLabel()` only
for known display enums. Never translate protocol values, paths, IDs, prompts,
user-authored text, tool arguments/results, or server-provided content.

The existing frontend test runner includes catalog, locale persistence,
reactivity, and rendered desktop/mobile checks in `app/src/i18n*_test.ts`.
