# Inline visual answers

Web conversations can mix normal Markdown with a fenced `answer-html` fragment.
The fragment belongs to the message DOM: no iframe, separate website, attachment,
server or Micro App is created. Use it for boundary maps, comparisons and short
explanatory flows, not every reply. Simple prose should remain Markdown.

## Authoring

````markdown
The control path is separate from game traffic.

```answer-html
<section class="answer-grid">
  <article class="answer-card">
    <h3>Control platform</h3>
    <div data-md>**API** owns accepted business state.

- Lifecycle decisions
- Billing and leases
- Canonical world pointer</div>
  </article>
  <article class="answer-card">
    <h3>Game host</h3>
    <div data-md>**Helper** reports host observations; **Java** writes the world.

SSH disconnecting does not prove the workload stopped.</div>
  </article>
</section>
<div class="answer-callout">Local tests do not certify production cloud integration.</div>
```

Snapshots become canonical only after accepted evidence and publication.
````

Use semantic HTML and the theme classes `answer-grid`, `answer-card`,
`answer-flow`, `answer-callout`, `answer-muted`, `answer-badge`. Layout adapts to
available message width and the application's light/dark theme. `details` and
`summary` provide native disclosure for secondary information. Put `data-md` on
a leaf container for Markdown inside HTML; ordinary raw HTML follows normal
Markdown parsing rules and does not automatically parse nested Markdown.

The fence is intentionally opt-in; ordinary `html` fences remain code examples.
Message source remains readable, copyable and persistent. Other channels do not
advertise this web renderer; use ordinary Markdown for them.

## Safety and meaning

The visual fragment uses a restrictive HTML allowlist. Scripts, inline styles, event handlers, frames, forms, SVG and external assets are unsupported. Author <style> blocks and custom classes are supported inside a per-fragment Shadow DOM boundary. CSS is parsed and validated before insertion: no imports, resource URLs (including fonts/images), animations/transitions, custom property definitions, or host/pseudo-element selectors. Responsive @media rules, grid/flex, typography and borders are supported. Use only --answer-* variables in var(); app-private variables are not part of this contract. Paint/layout containment clips oversized or positioned content to the message. No iframe or global observers are used. It is an explanatory surface,
not a permission dialog or a tool-execution interface. Do not imitate approval
controls or mark unverified architecture as implemented simply because it has a
polished layout. Keep essential conclusions visible; use disclosures only for
secondary detail.

A longer example reworks the Minecraft network/process/component explanation:
[boundary answer source](examples/minecraft-boundary-answer.md). It preserves the
original local-test limitations rather than upgrading them to production claims.

Implementation: `app/src/components/ChatTab.vue`; agent capability guidance:
`src/agent/context/runtime.ts`.

## Public theme variables

`app/src/styles.css` exposes the following stable aliases on `:root` and `.dark`.
They follow the app theme, not a separate answer palette. Font family tokens are
shared with the application. Current radius tokens are all square (`0px`).

| Group | Variables (all prefixed `--answer-`) |
| --- | --- |
| Surfaces | `bg`, `surface`, `surface-soft`, `surface-muted`, `code-bg`, `code-inline-bg` |
| Borders | `border`, `border-soft`, `border-strong`, `border-hover` |
| Text | `text`, `text-body`, `text-secondary`, `text-muted`, `text-faint`, `text-on-dark`, `text-on-accent` |
| Accent | `accent`, `accent-hover`, `accent-bg`, `accent-bg-hover` |
| Status pairs | `info` / `info-bg`, `success` / `success-bg`, `warning` / `warning-bg`, `danger` / `danger-bg` |
| Selection | `selection-bg`, `selection-border` |
| Radius | `radius`, `radius-sm`, `radius-control`, `radius-overlay` |
| Shadow colors | `shadow-color`, `shadow-soft-color` (colors, not full box-shadow declarations) |
| Typography | `font`, `font-mono` |

Use `text-on-accent` over `accent-bg`, not necessarily over `accent`: the latter
is a foreground emphasis color and becomes lighter in dark mode. Code-block
background should pair with `text-on-dark`; inline code uses normal text.
Inherit message font size and line height rather than creating a competing scale.

Use these tokens in author CSS, for example:

```html
<style>.comparison { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px; color:var(--answer-text); background:var(--answer-surface); border:1px solid var(--answer-border); }</style>
<section class="comparison"><div data-md>**Theme-aware** Markdown</div></section>
```

Styles apply only to this fragment. Streaming replaces the fragment and its shadow root; history renders through the same boundary. Unsupported CSS rules/declarations are discarded. Oversized layouts may be clipped; keep content responsive. External HTTPS links open safely without granting tool permissions.

Native text selection and external links work inside the shadow fragment; message
copy still copies readable Markdown source. Light-DOM-only search/highlight or
inspection utilities do not automatically traverse shadow roots. Render tests
exercise the same Vue directive lifecycle and Markdown sanitization boundary in
Electron, not a full mounted ChatTab with live backend services.
