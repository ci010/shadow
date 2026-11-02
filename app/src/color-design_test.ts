import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileStyle, parse } from 'vue/compiler-sfc'

type Declarations = Map<string, string>
type Sheet = Map<string, Declarations>
type Color = [number, number, number, number]

function stylesheet(source: string, filename: string): Sheet {
  const compiled = compileStyle({ source, filename, id: 'color-design', scoped: false })
  assert.deepEqual(compiled.errors, [], `${filename} parses`)
  assert.ok(compiled.rawResult)
  const sheet: Sheet = new Map()
  compiled.rawResult.root.walkRules(rule => {
    // Only unconditional rules: responsive overrides must not redefine a theme.
    if (rule.parent?.type !== 'root') return
    for (const selector of rule.selectors) {
      const declarations = sheet.get(selector) ?? new Map<string, string>()
      for (const node of rule.nodes) {
        if (node.type === 'decl') declarations.set(node.prop, node.value)
      }
      sheet.set(selector, declarations)
    }
  })
  return sheet
}

const globalStyles = stylesheet(await readFile(new URL('./styles.css', import.meta.url), 'utf8'), 'styles.css')
const components = new Map(await Promise.all([
  'ChatTab', 'MessageAction', 'MessagePreviewCard', 'SessionMessageDisclosure', 'ExecutionMessage', 'SessionActivity', 'ToolActivityGroup', 'ReasoningItem',
].map(async name => {
  const filename = `${name}.vue`
  const { descriptor, errors } = parse(await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8'))
  assert.deepEqual(errors, [], `${filename} parses`)
  return [name, stylesheet(descriptor.styles.map(style => style.content).join('\n'), filename)] as const
})))

function declarations(sheet: Sheet, selector: string): Declarations {
  const result = sheet.get(selector)
  assert.ok(result, `Missing CSS rule ${selector}`)
  return result
}

const light = declarations(globalStyles, ':root')
const themes = [
  { name: 'light', tokens: light },
  { name: 'dark', tokens: new Map([...light, ...declarations(globalStyles, '.dark')]) },
]
const surfaces = ['--c-bg', '--c-bg-soft', '--c-bg-card', '--c-bg-muted', '--c-bg-input']
const textTokens = ['--c-text', '--c-text-body', '--c-text-secondary', '--c-text-muted', '--c-text-faint']

function resolveValue(value: string, tokens: Declarations, trail: string[] = []): string {
  let resolved = value
  // Resolve innermost vars first, including nested fallbacks and inherited aliases.
  while (resolved.includes('var(')) {
    const next = resolved.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, token: string, fallback?: string) => {
      assert.ok(!trail.includes(token), `Cyclic color alias: ${[...trail, token].join(' -> ')}`)
      const definition = tokens.get(token) ?? fallback
      assert.ok(definition, `Missing color token ${token}`)
      return resolveValue(definition, tokens, [...trail, token])
    })
    assert.notEqual(next, resolved, `Unsupported CSS variable expression: ${resolved}`)
    resolved = next
  }
  return resolved.trim()
}

function color(value: string, tokens: Declarations): Color {
  const resolved = resolveValue(value, tokens)
  if (/^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(resolved)) {
    const hex = resolved.slice(1)
    const full = hex.length <= 4 ? [...hex].map(channel => channel.repeat(2)).join('') : hex
    const channels = full.match(/../g)!.map(channel => parseInt(channel, 16))
    return [channels[0]!, channels[1]!, channels[2]!, (channels[3] ?? 255) / 255]
  }
  const rgb = resolved.match(/^rgba?\(([^)]+)\)$/)
  assert.ok(rgb, `Unsupported palette color: ${resolved}`)
  const parts = rgb[1]!.trim().split(/[\s,/]+/)
  assert.ok(parts.length === 3 || parts.length === 4, `Invalid RGB color: ${resolved}`)
  const channels = parts.map((part, index) => parseFloat(part) * (part.endsWith('%') ? (index === 3 ? .01 : 2.55) : 1))
  assert.ok(channels.every((channel, index) => Number.isFinite(channel) && channel >= 0 && channel <= (index === 3 ? 1 : 255)), resolved)
  return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1]
}

function tokenColor(token: string, tokens: Declarations): Color {
  return color(`var(${token})`, tokens)
}

function over(foreground: Color, background: Color): Color {
  assert.equal(background[3], 1, 'Contrast calculations need an opaque backdrop')
  return [
    foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
    foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
    foreground[2] * foreground[3] + background[2] * (1 - foreground[3]),
    1,
  ]
}

function luminance(value: Color): number {
  const channels = value.slice(0, 3).map(channel => {
    const srgb = channel / 255
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
  })
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!
}

function contrast(foreground: Color, background: Color): number {
  const a = luminance(over(foreground, background))
  const b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

function requireContrast(foreground: Color, background: Color, minimum: number, label: string): void {
  const ratio = contrast(foreground, background)
  assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(3)}:1; requires ${minimum}:1`)
}

function requireNeutral(value: Color, label: string): void {
  assert.equal(value[0], value[1], `${label} must be grayscale`)
  assert.equal(value[1], value[2], `${label} must be grayscale`)
}

for (const { name, tokens } of themes) {
  test(`${name}: normal surfaces and general-purpose text are neutral, with cards above canvas`, () => {
    for (const token of [...surfaces, ...textTokens]) {
      const value = tokenColor(token, tokens)
      requireNeutral(value, `${name} ${token}`)
      assert.equal(value[3], 1, `${name} ${token} is opaque`)
    }
    assert.ok(luminance(tokenColor('--c-bg-card', tokens)) > luminance(tokenColor('--c-bg', tokens)),
      `${name} card luminance must exceed canvas luminance`)
  })

  for (const token of textTokens) {
    test(`${name}: ${token} is readable on every normal surface`, () => {
      for (const surface of surfaces) {
        requireContrast(tokenColor(token, tokens), tokenColor(surface, tokens), 4.5, `${name} ${token} on ${surface}`)
      }
    })
  }

  test(`${name}: focus blue is visible and primary action ink is readable, including selected surfaces`, () => {
    for (const surface of surfaces) {
      const background = tokenColor(surface, tokens)
      requireContrast(tokenColor('--c-blue', tokens), background, 3, `${name} --c-blue on ${surface}`)
      requireContrast(tokenColor('--c-primary', tokens), background, 4.5, `${name} --c-primary on ${surface}`)
      requireContrast(tokenColor('--c-primary', tokens), over(tokenColor('--c-selection-bg', tokens), background),
        4.5, `${name} --c-primary on selection over ${surface}`)
    }
  })

  test(`${name}: filled primary controls keep readable text at rest and on hover`, () => {
    for (const background of ['--c-primary-bg', '--c-primary-bg-hover']) {
      requireContrast(tokenColor('--c-text-on-primary', tokens), tokenColor(background, tokens),
        4.5, `${name} --c-text-on-primary on ${background}`)
    }
  })

  for (const status of ['success', 'error', 'warn', 'info']) {
    test(`${name}: ${status} ink is readable on its badge and normal surfaces`, () => {
      for (const surface of surfaces) {
        const background = tokenColor(surface, tokens)
        const foreground = tokenColor(`--c-${status}`, tokens)
        requireContrast(foreground, background, 4.5, `${name} --c-${status} on ${surface}`)
        requireContrast(foreground, over(tokenColor(`--c-${status}-bg`, tokens), background),
          4.5, `${name} --c-${status} on --c-${status}-bg over ${surface}`)
      }
    })
  }

  test(`${name}: input control boundaries remain distinguishable`, () => {
    requireContrast(tokenColor('--c-control-border', tokens), tokenColor('--c-bg-input', tokens),
      3, `${name} --c-control-border on --c-bg-input`)
  })

  test(`${name}: canvas dots remain visible but subordinate to text`, () => {
    const canvas = tokenColor('--c-bg', tokens)
    const ratio = contrast(tokenColor('--c-grid-dot', tokens), canvas)
    assert.ok(ratio >= 1.15 && ratio <= 1.4, `${name} decorative dot contrast: ${ratio}`)
  })

  test(`${name}: conversation aliases follow shared neutral surface and border tokens`, () => {
    for (const [alias, target] of [
      ['--c-chat-user-bg', '--c-bg-muted'],
      ['--c-chat-assistant-bg', '--c-bg-card'],
      ['--c-chat-action-bg', '--c-bg-soft'],
      ['--c-chat-border', '--c-border-soft'],
    ]) {
      assert.equal(tokens.get(alias!)?.replace(/\s/g, ''), `var(${target})`, `${name} ${alias}`)
      assert.deepEqual(tokenColor(alias!, tokens), tokenColor(target!, tokens))
    }
  })
}

function property(component: string, selector: string, name: string, inherited?: string): string {
  const sheet = components.get(component)!
  const value = sheet.get(selector)?.get(name) ?? (inherited ? declarations(sheet, inherited).get(name) : undefined)
  assert.ok(value, `${component} ${selector} needs ${name}`)
  return value
}

test('conversation surfaces consume the shared chat aliases', () => {
  for (const [component, selector, token] of [
    ['ChatTab', '.chat-user', '--c-chat-user-bg'],
    ['ChatTab', '.chat-assistant', '--c-chat-assistant-bg'],
    ['MessagePreviewCard', '.message-preview-card', '--c-chat-action-bg'],
  ]) {
    assert.equal(property(component!, selector!, 'background'), `var(${token})`)
  }
  for (const [component, selector] of [
    ['ChatTab', '.chat-bubble'], ['MessagePreviewCard', '.message-preview-card'],
  ]) {
    assert.ok(property(component!, selector!, 'border').includes('var(--c-chat-border)'), `${component} ${selector} border uses chat alias`)
  }
})

test('message preview cards cap previews without reserving empty lines or changing Markdown typography', () => {
  assert.equal(property('MessagePreviewCard', '.message-preview-content', 'min-height'), '0')
  assert.equal(property('MessagePreviewCard', '.message-preview-content', 'max-height'), '5lh')
  assert.equal(property('MessagePreviewCard', '.message-preview-card', 'font-size'), property('ChatTab', '.chat-bubble', 'font-size'))
  assert.equal(property('MessagePreviewCard', '.message-preview-card', 'line-height'), property('ChatTab', '.chat-bubble', 'line-height'))
  assert.equal(property('MessagePreviewCard', '.message-preview-body', 'grid-template-rows'), '1fr')
  assert.equal(property('MessagePreviewCard', '.message-preview-card[data-expanded="true"] .message-preview-body', 'grid-template-rows'), '1fr')
  assert.match(property('MessagePreviewCard', '.message-preview-body::after', 'background'), /linear-gradient.*var\(--c-chat-action-bg\)/)
  assert.equal(property('MessagePreviewCard', '.message-preview-body::after', 'pointer-events'), 'none')
  assert.equal(property('MessagePreviewCard', '.message-preview-card[data-expanded="true"] .message-preview-body::after', 'opacity'), '0')
})

test('conversation reading width belongs to the rail rather than Markdown', () => {
  assert.equal(light.get('--conversation-max-width'), '860px')
  assert.equal(light.get('--conversation-item-max-width'), '100%')
  for (const selector of ['.chat-message-list', '.chat-composer', '.session-status-row']) {
    assert.equal(property('ChatTab', selector, 'max-width'), 'var(--conversation-max-width)')
  }
  assert.equal(property('ChatTab', '.chat-message-list :deep(.prose)', 'max-width'), 'none')
  assert.equal(property('ChatTab', '.chat-user', 'align-self'), 'flex-end')
  assert.equal(property('ChatTab', '.chat-bubble', 'max-width'), '80%')
})

test('session source, reasoning and running tool text remain neutral rather than semantic status colors', () => {
  const reasoning = declarations(components.get('ReasoningItem')!, '.reasoning-item')
  assert.ok(!reasoning.has('border') && !reasoning.has('background'), 'Reasoning is a lightweight item, not a card')
  assert.equal(property('MessagePreviewCard', '.message-preview-card', 'color'), 'var(--c-text-secondary)')
  assert.equal(property('MessagePreviewCard', '.message-preview-card', 'background'), 'var(--c-chat-action-bg)')
  assert.ok(property('MessagePreviewCard', '.message-preview-card', 'border').includes('var(--c-chat-border)'))
  for (const { name, tokens } of themes) {
    for (const [component, selector] of [
      ['ReasoningItem', '.reasoning-item'], ['ToolActivityGroup', '.activity-status'],
    ]) {
      requireNeutral(color(property(component!, selector!, 'color'), tokens), `${name} ${component} ${selector}`)
    }
  }
})

test('session activity reserves success and error for completed and failed work', () => {
  assert.equal(property('SessionActivity', '.session-activity.completed', 'color'), 'var(--c-success)')
  assert.equal(property('SessionActivity', '.session-activity.failed', 'color'), 'var(--c-error)')
  for (const state of ['idle', 'tool', 'llm']) {
    const value = property('SessionActivity', `.session-activity.${state}`, 'color', '.session-activity')
    assert.doesNotMatch(value, /--c-(?:success|warn(?:ing)?|amber)\b/, `${state} must not imply success or warning`)
    for (const { name, tokens } of themes) {
      assert.notDeepEqual(color(value, tokens), tokenColor('--c-success', tokens), `${name} ${state} must not use success ink through an alias`)
      assert.notDeepEqual(color(value, tokens), tokenColor('--c-warn', tokens), `${name} ${state} must not use warning ink through an alias`)
    }
  }
})

test('selected project coordination accents the title without a filled selection block', () => {
  assert.equal(property('.admin-entry.selected', 'background', '.admin-entry'), 'transparent')
  assert.equal(property('.admin-entry.selected', 'color'), 'var(--c-primary)')
  assert.equal(property('.admin-entry.selected > span', 'text-decoration'), 'underline')
  assert.equal(property('.admin-entry:focus-visible', 'outline'), '2px solid var(--c-blue)')
})

test('timeline focus does not frame the canvas while conversation controls retain focus indicators', () => {
  assert.equal(property('ChatTab', '.chat-messages:focus', 'outline'), 'none')
  assert.equal(property('ChatTab', '.conversation-find:focus-visible', 'outline'), '2px solid var(--c-blue)')
})

test('composer keeps a quiet resting edge and a visible interactive focus boundary', () => {
  assert.equal(property('ChatTab', '.composer-box', 'border'), '1px solid var(--c-border)')
  assert.equal(property('ChatTab', '.composer-box:focus-within', 'border-color'), 'var(--c-blue)')
})

test('collaboration messages keep compact neutral previews and uncapped expanded text', () => {
  assert.equal(property('SessionMessageDisclosure', '.session-message', 'border-color'), 'transparent')
  assert.equal(property('SessionMessageDisclosure', '.session-message :deep(.message-preview-header)', 'font-size'), '12px')
  assert.equal(property('SessionMessageDisclosure', '.session-message :deep(.message-preview-header)', 'color'), 'var(--c-text-secondary)')
  assert.equal(property('SessionMessageDisclosure', '.session-message :deep(.message-preview-content)', 'max-height'), '3lh')
  assert.equal(property('SessionMessageDisclosure', '.session-message[data-expanded="true"] :deep(.message-preview-content)', 'max-height'), 'none')
})

test('Markdown quotes share a neutral surface with a restrained blue rule and normal type without generated punctuation', async () => {
  const quote = declarations(globalStyles, ':where(.prose, .markdown-body, .file-markdown) blockquote')
  assert.equal(quote.get('border-left'), '3px solid var(--c-markdown-rule)')
  assert.equal(quote.get('background'), 'var(--c-bg-muted)')
  assert.equal(quote.get('color'), 'var(--c-text-body)')
  assert.equal(quote.get('font-style'), 'normal')
  assert.equal(quote.get('font-weight'), '400')
  assert.equal(quote.get('quotes'), 'none')
  const typography = await readFile(new URL('../unocss.config.ts', import.meta.url), 'utf8')
  assert.match(typography, /'blockquote p::before,blockquote p::after': \{ content: 'none' \}/)
})

test('collaboration touch target override follows the desktop link rule', async () => {
  const source = await readFile(new URL('./components/SessionMessageDisclosure.vue', import.meta.url), 'utf8')
  const desktop = source.indexOf('.session-message-link { display: inline-flex;')
  const media = source.indexOf('@media (max-width: 700px), (pointer: coarse)')
  assert.ok(desktop >= 0 && media > desktop)
  assert.match(source.slice(media), /\.session-message-link \{ min-height: 44px; \}/)
  assert.ok(!source.slice(media).includes('min-height: 28px'))
})

test('nested Markdown quotes use smaller transparent insets in global and preset styles', async () => {
  const nested = declarations(globalStyles, ':where(.prose, .markdown-body, .file-markdown) blockquote blockquote')
  assert.equal(nested.get('background'), 'transparent')
  assert.equal(nested.get('padding'), '0.25em 0.75em')
  assert.equal(nested.get('margin'), '0.65em 0')
  const typography = await readFile(new URL('../unocss.config.ts', import.meta.url), 'utf8')
  assert.match(typography, /'blockquote blockquote': \{ margin: '0.65em 0', padding: '0.25em 0.75em', background: 'transparent' \}/)
})


test('Markdown structure accents share blue tokens across prose, knowledge and file previews', async () => {
  const scope = ':is(.prose, .markdown-body, .file-markdown)'
  assert.equal(declarations(globalStyles, ':root').get('--c-markdown-rule'), 'var(--c-selection-border)')
  assert.equal(declarations(globalStyles, ':root').get('--c-markdown-table-bg'), 'transparent')
  assert.equal(declarations(globalStyles, ':root').get('--c-markdown-table-rule'), 'color-mix(in srgb, var(--c-selection-border) 25%, var(--c-border))')
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  assert.ok(css.includes(`${scope} table tbody tr:hover { background: var(--c-bg-muted); }`))
  assert.equal(declarations(globalStyles, ':root').get('--c-markdown-table-header'), 'color-mix(in srgb, var(--c-info-bg) 35%, var(--c-bg-card))')
  const table = declarations(globalStyles, `${scope} table`)
  assert.equal(table.get('border'), '1px solid var(--c-markdown-table-rule)')
  assert.equal(table.get('background'), 'var(--c-markdown-table-bg)')
  assert.equal(table.get('color'), 'var(--c-text-body)')
  assert.equal(table.get('overflow-x'), 'auto')
  const header = declarations(globalStyles, `${scope} table th`)
  assert.equal(header.get('background'), 'var(--c-markdown-table-header)')
  assert.equal(header.get('color'), 'var(--c-text)')
  assert.equal(header.get('border-bottom'), '1px solid var(--c-markdown-table-rule)')
  const headings = declarations(globalStyles, `${scope} :is(h1, h2, h3, h4, h5, h6)`)
  assert.deepEqual([...headings], [['border-color', 'var(--c-markdown-rule)']], 'recolor existing rules without creating new heading borders')
  const preview = await readFile(new URL('./components/files/FilePreviewModal.vue', import.meta.url), 'utf8')
  assert.ok(!preview.includes('.file-markdown :deep(table)'))
  assert.ok(!preview.includes('.file-markdown :deep(th)'))
  const typography = await readFile(new URL('../unocss.config.ts', import.meta.url), 'utf8')
  assert.match(typography, /'border-left': '3px solid var\(--c-markdown-rule\)'/)
  assert.match(typography, /'h1,h2,h3,h4,h5,h6': \{ color: 'var\(--c-text\)', 'border-color': 'var\(--c-markdown-rule\)' \}/)
  assert.match(typography, /'a': \{ color: 'var\(--c-primary\)' \}/)
})

for (const { name, tokens } of themes) {
  test(`${name}: Markdown blue tint retains readable neutral body and heading ink`, () => {
    const info = tokenColor('--c-info-bg', tokens)
    const card = tokenColor('--c-bg-card', tokens)
    // Check the neutral surface and the blue header (35%); body stays transparent.
    const tints = [0, .35].map(weight =>
      [0, 1, 2].map(i => info[i]! * weight + card[i]! * (1 - weight)).concat(1) as Color)
    for (const bg of tints) {
      for (const ink of ['--c-text', '--c-text-body', '--c-text-secondary']) {
        assert.ok(contrast(tokenColor(ink, tokens), bg) >= 4.5, `${name} ${ink} on Markdown tint`)
      }
    }
  })
}
