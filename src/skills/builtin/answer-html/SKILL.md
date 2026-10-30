---
name: answer-html
description: "Advanced web answers with flexible inline HTML layouts when Markdown or more prose would be less clear."
metadata:
  category: tools
---

# Flexible inline answers

Prefer ordinary Markdown when it already explains clearly. Use this advanced
answering format when spatial grouping, side-by-side comparison, hierarchy or
progressive detail makes an explanation clearer than adding more prose. Do not
turn every answer into cards or add decoration without explanatory value.
For node/edge relationships, dependencies or processes, read
`v:skills/answer-flow` instead. Load both only if both genuinely help.

This is an inline web reply, not a website, attachment, iframe, micro app or
separate deliverable. No build, server or tool execution is needed. Other channels
may show the fence as source; use Markdown/text there.

## Authoring

Use a fenced `answer-html` block with a semantic HTML fragment, optionally mixed
with ordinary Markdown outside the block. Prefer section, article, div, headings,
p, ul/li and details/summary. Keep the conclusion and important caveats visible.

Themed classes:
- `answer-grid`: responsive groups of cards.
- `answer-card`: a distinct grouped explanation.
- `answer-flow`: wrapping flex layout (not the node/edge answer-flow renderer).
- `answer-callout`: an important qualification or conclusion.
- `answer-muted`: secondary text, never the only place for a critical warning.
- `answer-badge`: a short textual label, not a button or approval control.

Place `data-md` on leaf containers to parse Markdown within HTML. Keep HTML
structure outside these Markdown leaves.

````markdown
The trade-off is ownership versus independence:

```answer-html
<section class="answer-grid">
  <article class="answer-card">
    <h3>One owner</h3>
    <div data-md>**Best for:** tightly coupled changes with a shared interface.</div>
  </article>
  <article class="answer-card">
    <h3>Independent scopes</h3>
    <div data-md>**Best for:** parallel work with explicit file ownership.</div>
  </article>
</section>
```
````

## Styling and safety

Reuse themed classes first. Isolated `<style>` CSS supports custom classes,
grid/flex and responsive queries. Inherited `--answer-*` theme variables cover
surfaces, text, accent, status, borders, radii and fonts. Keep CSS inside the
message, respect small screens, and do not target the host application.

HTML is sanitized: no scripts, inline styles/events, iframe, forms, SVG, imports,
network assets, animations or host selectors. Do not depend on these being
rendered or use CSS to simulate unsupported interaction.

Do not imitate approval controls or imply authority/certainty through layout.
Distinguish implemented, proposed and unverified claims in text; do not rely on
color alone. Keep content readable in the application's theme. Before sending,
check that the layout improves the explanation rather than hides caveats or
merely repeats the prose.
