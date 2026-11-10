import type { ProjectUsage } from '../../src/projects/usage-contract.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

interface ElementNode {
  tag: string
  text: string
  props: Record<string, unknown>
  children: ElementNode[]
  style: Record<string, string>
  parent?: ElementNode
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [], style: {} })
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

function mount(t: TestContext, filename: string, props: Record<string, unknown>) {
  function load(filename: string): Component {
    const url = new URL(`./components/${filename}`, import.meta.url)
    const { descriptor } = parse(readFileSync(url, 'utf8'))
    const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const module = { exports: {} as { default: Component } }
    const require = createRequire(url)
    // The host renderer has no DOM option/MutationObserver API. Exercise the
    // usage-to-select contract here; UiSelect's DOM behavior has its own tests.
    const fixtureRequire = (id: string) => id === './UiSelect.vue' ? { default: defineComponent({
      inheritAttrs: false,
      setup: (_props, { attrs, slots }) => () => h('select', attrs, slots.default?.()),
    }) } : id === './UsageTrendChart.vue' ? { default: defineComponent({
      props: ['title', 'kind', 'points', 'formatAxis'],
      setup: props => () => h('usage-trend-chart', { ...props }),
    }) } : require(id)
    new Function('require', 'module', 'exports', outputText)(fixtureRequire, module, module.exports)
    return module.exports.default
  }
  const component = load(filename)
  const renderer = createRenderer<ElementNode, ElementNode>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index === -1) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: () => element('body'),
  })
  const root = element('root')
  const state = reactive(props)
  const app = renderer.createApp(defineComponent({ setup: () => () => h(component, state) }))
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (): ElementNode[] => {
    const visit = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  return { state, nodes, unmount: () => app.unmount(),
    text: () => nodes().filter(node => node.tag !== '#comment').map(node => node.text).join(' '),
    button: () => {
      const button = nodes().find(node => node.tag === 'button')!
      return { props: button.props, click: () => (button.props.onClick as () => Promise<void>)() }
    },
  }
}


const metrics = { calls: 2, tokens: 1234, unknownTokenCalls: 1, costs: [{ currency: 'USD', amount: 0.25 }, { currency: 'CNY', amount: 1 }], unknownCostCalls: 1, durationMs: 1500, unknownDurationCalls: 1 }
function response(projectId = 'p'): ProjectUsage {
  return { projectId, asOf: '2026-10-01T12:00:00Z', timeZone: 'UTC', activity: { total: { models: [], tools: [] }, today: { models: [], tools: [] }, past7Days: { models: [], tools: [] }, month: { models: [], tools: [] } }, total: metrics, today: metrics, past7Days: metrics, month: metrics, daily: [{ date: '2026-10-01', usage: metrics }], scanLimitReached: true, untrackedSessions: 1, undatedCalls: 2 }
}

test('Project usage renders all windows, estimates, partial durations and UTC daily details', async t => {
  let requested = ''
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo) => { requested = String(url); return Response.json(response()) })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  assert.equal(requested, 'http://fixture/projects/p/api/project/usage')
  assert.match(view.text(), /Today.*Past 7 days.*This month.*All time/)
  assert.ok(view.nodes().some(n => n.props.title === '1,234'))
  assert.match(view.text(), /0.25\s+USD\s+1.00\s+CNY/)
  assert.ok(view.nodes().some(n => n.props.title === '1.5 s'))
  assert.match(view.text(), /2026-10-01/)
  assert.match(view.text(), /Calendar dates use UTC/)
  assert.match(view.text(), /not invoices/)
  assert.match(view.text(), /not wall-clock work time/)
  assert.match(view.text(), /Scan capped: Yes/)
})

test('unknown historical costs and durations are unavailable, not zero; retry is explicit', async t => {
  let fails = true
  t.mock.method(globalThis, 'fetch', async () => {
    if (fails) return new Response('', { status: 500 })
    const result = response()
    result.past7Days = { ...metrics, costs: [], durationMs: null, tokens: null }
    return Response.json(result)
  })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle(); assert.match(view.text(), /Could not load Project usage/)
  fails = false; await view.button().click(); await settle()
  assert.match(view.text(), /Unavailable/)
  assert.doesNotMatch(view.text(), /Could not load Project usage/)
})

test('Project switching clears old data and late responses cannot leak across Projects', async t => {
  let finish: ((value: Response) => void) | undefined
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo) => {
    if (String(url).includes('/projects/p/')) return new Promise<Response>(resolve => { finish = resolve })
    return Response.json(response('q'))
  })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  view.state.apiBase = 'http://fixture/projects/q'; view.state.projectId = 'q'
  await settle()
  finish?.(Response.json({ ...response('p'), total: { ...metrics, tokens: 99999 } }))
  await settle()
  assert.doesNotMatch(view.text(), /99,999/)
  assert.ok(view.nodes().some(n => n.props.title === '1,234'))
  view.state.active = false; await settle()
})

test('inactive usage never fetches; mismatched Project responses are rejected', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response('foreign')) })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: false })
  await settle(); assert.equal(calls, 0)
  view.state.active = true; await settle()
  assert.equal(calls, 1)
  assert.match(view.text(), /Could not load Project usage/)
  assert.doesNotMatch(view.text(), /1,234/)
})


test('three chronological charts expose known values, keyboard targets and 7/30 day switching without refetch', async t => {
  let requests = 0
  const result = response()
  result.daily[0].usage = { ...metrics, costs: [...metrics.costs, { currency: 'AI_CREDITS', amount: 12 }] }
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(result) })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  assert.equal(view.nodes().filter(n => n.tag === 'usage-trend-chart').length, 3)
  assert.match(view.text(), /1 of 7 days available/)
  const chart = view.nodes().find(n => n.tag === 'usage-trend-chart')!
  const points = chart.props.points as Array<{ date: string; value: number | null; label: string; partial: boolean }>
  assert.equal(chart.props.kind, 'bar')
  assert.equal(typeof chart.props.formatAxis, 'function')
  assert.equal(points.length, 7)
  assert.ok(points.slice(0, -1).every(p => p.value === null && /Unavailable/.test(p.label)))
  assert.deepEqual(points.at(-1), { date: '2026-10-01', value: 1234, label: '2026-10-01: 1,234', partial: true })
  assert.doesNotMatch(view.text(), /Token share by day/)
  const change = view.nodes().find(n => n.tag === 'button' && n.text === 'Last 30 days')!
  ;(change.props.onClick as () => void)(); await settle()
  assert.equal(change.props['aria-pressed'], true)
  assert.match(view.text(), /1 of 30 days available/)
  assert.equal(requests, 1)
  assert.match(view.text(), /Load daily history/) // no daily rows before explicit demand
  assert.doesNotMatch(view.text(), /13.25/)
})

test('zero charts remain real zero and missing telemetry has no donut or fabricated points', async t => {
  const result = response()
  result.daily = [{ date: '2026-10-01', usage: { ...metrics, tokens: 0, durationMs: 0 } }]
  t.mock.method(globalThis, 'fetch', async () => Response.json(result))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  assert.doesNotMatch(view.text(), /Token share by day/)
  const charts = () => view.nodes().filter(n => n.tag === 'usage-trend-chart')
  assert.equal(charts().length, 3)
  for (const chart of [charts()[0], charts()[2]]) assert.equal((chart.props.points as Array<{value:number}>).at(-1)?.value, 0)
  assert.match((charts()[2].props.points as Array<{label:string}>).at(-1)!.label, /0 s/)
  result.daily[0].usage = { ...metrics, tokens: null, durationMs: null, costs: [] }
  await view.button().click(); await settle()
  assert.equal(view.nodes().filter(n => n.tag === 'usage-trend-chart').length, 0)
  assert.match(view.text(), /0 of 7 days available/)
  assert.match(view.text(), /Some usage is unavailable or partial/)
})


test('cost chart switches units without mixing totals and preserves partial/absent-unit gaps', async t => {
  const result = response()
  result.daily = [
    { date: '2026-10-01', usage: { ...metrics, costs: [{ currency: 'USD', amount: 2 }, { currency: 'CNY', amount: 30 }, { currency: 'AI_CREDITS', amount: 400 }] } },
    { date: '2026-09-30', usage: { ...metrics, costs: [{ currency: 'USD', amount: 7 }], unknownCostCalls: 0 } },
    { date: '2026-09-29', usage: { ...metrics, costs: [{ currency: 'USD', amount: 8 }], unknownCostCalls: 1 } },
  ]
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(result) })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  const bars = () => (view.nodes().filter(n => n.tag === 'usage-trend-chart')[1]!.props.points as Array<{ value: number | null; label: string; partial: boolean }>).filter(p => p.value !== null)
  assert.equal(bars().length, 3)
  assert.match(String(bars().at(-1)?.label), /6 USD/)
  const select = view.nodes().find(n => n.tag === 'select')!
  ;(select.props.onChange as (event: unknown) => void)({ target: { value: 'CNY' } }); await settle()
  assert.equal(bars().length, 2)
  assert.match(String(bars()[0].label), /2026-09-30: 0 CNY$/)
  assert.match(String(bars()[1].label), /30 CNY/)
  assert.ok(bars().every(n => !String(n.label).includes('USD')))
  assert.ok(select.children.every(n => n.props.value !== 'AI_CREDITS'))
  const change = view.nodes().find(n => n.tag === 'button' && n.text === 'Last 30 days')!
  ;(change.props.onClick as () => void)(); await settle()
  assert.equal(bars().length, 2)
  assert.equal(requests, 1)
  assert.match(view.text(), /Some usage is unavailable or partial/)
})

test('four KPI cards follow summary selection independently of the trend window; completeness is collapsed', async t => {
  const result = response()
  result.past7Days = { ...metrics, tokens: 156300000, durationMs: 293000 }
  result.month = { ...metrics, tokens: 42000000, durationMs: 3600000, calls: 10000 }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(result) })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  const cards = () => view.nodes().filter(n => n.props.class === 'metric-card')
  const flatten = (node: ElementNode): string => [node.text, ...node.children.map(flatten)].join(' ')
  assert.equal(cards().length, 4)
  assert.match(flatten(cards()[0]), /156.3M/)
  assert.match(flatten(cards()[2]), /4m 53s/)
  assert.equal(view.nodes().find(n => n.tag === 'button' && n.text === 'Past 7 days')?.props['aria-pressed'], true)
  const selectMonth = view.nodes().find(n => n.tag === 'button' && n.text === 'This month')!
  ;(selectMonth.props.onClick as () => void)(); await settle()
  assert.match(flatten(cards()[0]), /42M/)
  assert.match(flatten(cards()[2]), /1h 0m 0s/)
  assert.match(flatten(cards()[3]), /10K/)
  assert.match(view.text(), /1 of 7 days available/)
  assert.match(view.text(), /Daily trends have their own date range/)
  const details = view.nodes().filter(n => n.tag === 'details')
  assert.equal(details.length, 2)
  assert.ok(details.every(n => !n.props.open))
  assert.match(flatten(details[0]), /Missing token telemetry: 1 calls/)
  assert.match(flatten(details[0]), /Scan capped: Yes/)
  assert.ok(cards().every(n => !flatten(n).includes('calls missing')))
  assert.ok(view.nodes().some(n => n.props.title === '156,300,000 (partial; 1 calls missing)') === false) // titles follow the selected period
  assert.ok(view.nodes().some(n => n.props.title === '42,000,000'))
  for (const [label, count] of [['Today', '1.2K'], ['All time', '1.2K'], ['Past 7 days', '156.3M']] as const) {
    const button = view.nodes().find(n => n.tag === 'button' && n.text === label)!
    ;(button.props.onClick as () => void)(); await settle()
    assert.equal(button.props['aria-pressed'], true)
    assert.match(flatten(cards()[0]), new RegExp(count.replace('.', '\\.')))
    assert.match(view.text(), /1 of 7 days available/)
  }
  const costRows = view.nodes().find(n => n.props.class === 'cost-values')!.children.filter(n => n.tag === 'div')
  assert.equal(costRows.length, 2)
  assert.match(flatten(costRows[0]), /0.25\s+USD/)
  assert.match(flatten(costRows[1]), /1.00\s+CNY/)
  assert.equal(requests, 1)
})

test('complete data has no warning or partial badges but retains zero-count completeness details', async t => {
  const result = response()
  const complete = { ...metrics, unknownTokenCalls: 0, unknownCostCalls: 0, unknownDurationCalls: 0 }
  Object.assign(result, { total: complete, today: complete, past7Days: complete, month: complete, scanLimitReached: false, untrackedSessions: 0, undatedCalls: 0 })
  result.daily = [{ date: '2026-10-01', usage: complete }]
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/daily?') ? { projectId: 'p', asOf: result.asOf, page: 1, pageSize: 10, total: 1, hasMore: false, daily: result.daily } : result))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  assert.equal(view.nodes().filter(n => n.props.class === 'partial').length, 0)
  assert.doesNotMatch(view.text(), /Some usage is unavailable or partial/)
  assert.match(view.text(), /Missing token telemetry: 0 calls/)
  assert.match(view.text(), /Scan capped: No/)
  ;(view.nodes().find(n => n.tag === 'button' && n.text === 'Load daily history')!.props.onClick as () => void)(); await settle()
  const cells = view.nodes().filter(n => n.tag === 'td' && n.props.title)
  assert.ok(cells.some(n => n.props.title === '1,234'))
  assert.ok(cells.some(n => String(n.props.title).includes('0.25 USD · 1 CNY')))
})

test('latest refresh wins even if the aborted fetch ignores its signal', async t => {
  const pending: Array<(response: Response) => void> = []
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => pending.push(resolve)))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  const refresh = view.button().click()
  const fresh = response(); fresh.past7Days = { ...metrics, tokens: 87654321 }
  pending[1](Response.json(fresh)); await refresh; await settle()
  pending[0](Response.json(response())); await settle()
  assert.ok(view.nodes().some(n => String(n.props.title).includes('87,654,321')))
  assert.match(view.text(), /87.7M/)
})


test('daily history is lazy, bounded, retryable and isolates late page responses on refresh/Project change', async t => {
  const pending: Array<{ url: string; finish: (r: Response) => void }> = []
  let dailyFails = false
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url)
    if (!path.includes('/daily?')) return Response.json(response(path.includes('/q/') ? 'q' : 'p'))
    if (dailyFails) return new Response('', { status: 500 })
    return new Promise<Response>(finish => pending.push({ url: path, finish }))
  })
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  const click = (text: string) => (view.nodes().find(n => n.tag === 'button' && n.text === text)!.props.onClick as () => void)()
  const page = (n: number, projectId = 'p') => ({ projectId, asOf: response().asOf, page: n, pageSize: 10, total: 11, hasMore: n === 1, daily: [{ date: n === 1 ? '2026-08-01' : '2026-07-01', usage: metrics }] })
  await settle(); assert.equal(pending.length, 0)
  assert.equal(view.nodes().filter(n => n.tag === 'td').length, 0)
  click('Load daily history'); await settle(); assert.match(view.text(), /Loading daily history/)
  pending[0].finish(Response.json(page(1))); await settle()
  assert.match(view.text(), /Page 1 · 11 dates/)
  dailyFails = true; click('Next page'); await settle()
  assert.match(view.text(), /Could not load daily history/)
  assert.match(view.text(), /2026-08-01/)
  dailyFails = false; click('Retry'); await settle()
  assert.match(pending[1].url, /page=2$/)
  pending[1].finish(Response.json(page(2))); await settle()
  assert.equal(view.nodes().find(n => n.tag === 'button' && n.text === 'Next page')!.props.disabled, true)
  click('Previous page'); await settle()
  await view.button().click(); await settle()
  pending[2].finish(Response.json(page(1))); await settle()
  assert.doesNotMatch(view.text(), /2026-08-01/)
  click('Load daily history'); await settle()
  view.state.apiBase = 'http://fixture/projects/q'; view.state.projectId = 'q'; await settle()
  pending[3].finish(Response.json(page(1))); await settle()
  assert.doesNotMatch(view.text(), /2026-08-01/)
})

test('cost defaults to available currency but does not override explicit selection; absent costs show empty state', async t => {
  const result = response(); result.daily[0].usage = { ...metrics, costs: [{ currency: 'CNY', amount: 2 }] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(result))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  const select = () => view.nodes().find(n => n.tag === 'select')!
  assert.equal(select().props.value, 'CNY')
  ;(select().props.onChange as (e: unknown) => void)({ target: { value: 'USD' } }); await settle()
  assert.match(view.text(), /No known cost in this window/)
  assert.doesNotMatch(view.text(), /0.000001 USD/)
  await view.button().click(); await settle()
  assert.equal(select().props.value, 'USD')
})


test('usage styling inherits real light/dark theme tokens and panel-width layout', () => {
  const source = readFileSync(new URL('./components/ProjectUsage.vue', import.meta.url), 'utf8')
  const global = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  assert.equal(descriptor.styles.length, 1)
  const css = descriptor.styles[0]!.content
  assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\brgba?\(/i)
  for (const radius of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.match(radius[1]!, /^var\(--radius-(?:sm|surface|control)\)$/)
  }
  for (const [, token] of source.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(global.includes(`${token}:`), `undefined theme token ${token}`)
    if (token!.startsWith('--c-')) assert.ok(global.slice(global.indexOf('.dark {')).includes(`${token}:`), `missing dark override ${token}`)
  }
  assert.match(css, /container:\s*usage \/ inline-size/)
  assert.match(css, /@container usage \(max-width: 850px\)/)
  assert.doesNotMatch(css, /@media|\dvw/)
  assert.match(css, /\.token-card \{ grid-column: 1 \/ -1;/)
  assert.doesNotMatch(css, /donut|share-card/)
  assert.match(source, /<UiSelect :value="costUnit"/)
  assert.equal((source.match(/<button /g) ?? []).length, (source.match(/<button class="btn btn-sm"/g) ?? []).length)
})

test('three chart slots use theme-derived marks and matching accessible titles', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(response()))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  const charts = view.nodes().filter(n => n.tag === 'article' && String(n.props.class).includes('chart-card'))
  assert.equal(charts.length, 3)
  for (const chart of charts) {
    const component = chart.children.find(n => n.tag === 'usage-trend-chart')!
    assert.ok(component)
    assert.match(String(component.props.title), /Daily/)
    assert.ok(['bar', 'line'].includes(String(component.props.kind)))
    assert.equal(typeof component.props.formatAxis, 'function')
  }
  const select = view.nodes().find(n => n.tag === 'select')!
  assert.equal(select.props['aria-label'], 'Cost unit')
})


test('credit-only and mixed USD estimates use one conversion across summary, chart, history and refresh', async t => {
  const result = response()
  const converted = { ...metrics, costs: [{ currency: 'AI_CREDITS' as const, amount: 48400 }, { currency: 'USD' as const, amount: 0.02 }] }
  Object.assign(result, { total: converted, today: converted, past7Days: converted, month: converted })
  result.daily = [{ date: '2026-10-01', usage: converted }]
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/daily?')
    ? { projectId: 'p', asOf: result.asOf, page: 1, pageSize: 10, total: 1, hasMore: false, daily: result.daily }
    : result))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  const costBars = () => (view.nodes().filter(n => n.tag === 'usage-trend-chart')[1]!.props.points as Array<{value:number|null;label:string;partial:boolean}>).filter(p => p.value !== null)
  await settle()
  assert.match(view.text(), /484.02\s+USD/)
  assert.equal(view.nodes().filter(n => n.tag === 'select').length, 0) // no irrelevant unit selector for USD/credits
  assert.match(String(costBars()[0].label), /484.02 USD/)
  assert.equal(costBars()[0].partial, true)
  assert.match(view.text(), /100 AI credits = 1 USD/)
  assert.doesNotMatch(view.text(), /AI_CREDITS|not converted or added/)
  ;(view.nodes().find(n => n.tag === 'button' && n.text === 'Load daily history')!.props.onClick as () => void)()
  await settle()
  assert.ok(view.nodes().some(n => n.tag === 'td' && n.props.title === '484.02 USD'))
  await view.button().click(); await settle()
  assert.match(String(costBars()[0].label), /484.02 USD/)
  converted.costs = [{ currency: 'AI_CREDITS', amount: 100 }]
  await view.button().click(); await settle()
  assert.match(view.text(), /1.00\s+USD/)
  assert.match(String(costBars()[0].label), /1 USD/)
})


test('model and tool counts follow the summary period; missing-data notices stay in the bottom disclosure', async t => {
  const result = response()
  result.activity.past7Days = { models: [{ name: 'fixture-model', calls: 17 }], tools: [{ name: 'dynamic_tool', calls: 9 }] }
  result.activity.today = { models: [{ name: 'today-model', calls: 1 }], tools: [] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(result))
  const view = mount(t, 'ProjectUsage.vue', { apiBase: 'http://fixture/projects/p', projectId: 'p', active: true })
  await settle()
  assert.match(view.text(), /fixture-model.*17/)
  assert.match(view.text(), /dynamic_tool.*9/)
  assert.equal(view.nodes().filter(n => n.tag === 'small' && n.text === 'Partial data').length, 0)
  const notice = view.nodes().find(n => n.tag === 'p' && n.text.includes('Some usage is unavailable'))!
  assert.equal(notice.parent?.tag, 'details')
  assert.equal(notice.parent?.props.class, 'completeness')
  const today = view.nodes().find(n => n.tag === 'button' && n.text === 'Today')!
  ;(today.props.onClick as () => void)()
  await settle()
  assert.match(view.text(), /today-model/)
  assert.doesNotMatch(view.text(), /fixture-model|dynamic_tool/)
  assert.match(view.text(), /No recorded calls in this period/)
})
