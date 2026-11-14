# Frontend Markdown

`markdown.ts` constructs the synchronous markdown-exit parser used by ChatTab,
SystemPromptCard, knowledge entries and Markdown inside answer-HTML fragments.
Callers retain their own DOMPurify policy and mobile-resource replacement.
System prompts disable raw HTML; answer fences are opt-in only for chat.
Shared lazy Shiki highlighting stays synchronous and invalidates Vue rendering
when a grammar finishes loading. `markdown-it-cjk-friendly` adjusts inline delimiter
scanning for CJK emphasis and strikethrough punctuation boundaries in every shared
parser instance. Space-padded strong-label compatibility remains a separate display
adapter before text joining, respecting code, links, escapes, raw HTML and math
token boundaries; it no longer repairs CJK punctuation itself.

Math uses @mdit/plugin-katex (`delimiters: all`, untrusted, bounded expansion and
size). Small adapters preserve inline `$$...$$` and dollar math before `_`.
The inline-display adapter checks only the current position and at most 16 KiB;
it delegates all TeX rendering to the plugin, emitting spans rather than nested
paragraphs. Other plugin searches are capped at 16 KiB; final-closer caches avoid
repeated suffix scans of entirely unclosed streamed math. These are input
bounds, not an independent TeX scanner or asynchronous worker. There is no
universal frame-time guarantee for arbitrary valid TeX or enormous documents.

Intentional upstream grammar differences versus the former Marked extension:
- Bracket inline math may cross a newline; empty display math is accepted.
- Block TeX can interrupt a paragraph. A multiline backtick span interrupted by
  a standalone display opener is parsed as a block (as with other interrupting
  block constructs); fenced/indented code and single-line code remain literal.
- Failed TeX is escaped and shown with its delimiters, not executable markup.
- Both inline and display math enforce a 16,384-character content bound. The
  former block extension accidentally admitted one extra trailing character.
- Markdown-exit follows markdown-it's CommonMark/GFM table and link rules;
  serialized HTML whitespace and list markup need not be byte-identical to
  Marked. Task checkboxes use @mdit/plugin-tasklist and stay disabled.

Marked is deliberately retained for `file-selection.ts`: its sequential `raw`
root-token coverage underpins the tested source-line provenance contract.
Replacing it without a separate source-map migration would risk incorrect quote
line numbers. Its existing tests and legacy Markdown-only renderer fixtures are
not chat-rendering implementations. No bespoke math scanner remains.

Regression coverage: `markdown-math_test.ts`, `markdown-strong-compat_test.ts`,
`markdown-highlight_test.ts`, `system-prompt-rendered_test.ts`,
`answer-html_test.ts`, and `file-selection_test.ts`.
