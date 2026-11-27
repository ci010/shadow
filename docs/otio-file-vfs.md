# OTIO file subpath views

Local `read` accepts stateless, read-only views below a UTF-8 `.otio` file:

- `./film/edit.otio/overview`: source hash, counts, rate/duration and follow references.
- `./film/edit.otio/timeline`: shared parser's projected node summaries, not a second copy of the raw JSON.
- `./film/edit.otio/tracks`: tracks and their detail references.
- `./film/edit.otio/tracks/<id>`: one track and its **direct** children, not repeated descendants.
- `./film/edit.otio/clips`: paged clip summaries and detail references (overview does not list every clip).
- `./film/edit.otio/clips/<id>`: one clip, projected timing and authored object, subject to the record budget below.
- `./film/edit.otio/media`: authored media references, active keys and target URLs.
- `./film/edit.otio/diagnostics`: parser warnings and interpretation limits.

Read `overview` first and follow the returned paths rather than constructing IDs.
IDs are a reversible hex encoding of the parser's source JSON pointer. They are
stable for an unchanged structural location, not persistent editorial identities:
insertions/reordering can change them. Every view includes `sourceVersion`, a
SHA-256 of the bytes actually parsed. Compare it across calls/pages and restart
inspection if it changes. No index or parsed state survives a call.

Every partial read (including the first truncated page, any `offset > 1` page,
and an empty page beyond EOF) starts with an unnumbered
`[OTIO snapshot {"source":"...","sourceVersion":"sha256:..."}]` receipt for the
bytes parsed by that call. Every search result also carries this receipt,
including empty and budget-limited results. The receipt is transport metadata,
**not a view/body line**: it does not consume an offset or change grep line
references, `flag: 'n'` numbering, or the next-page offset. A complete first read
page remains pure JSON and contains the same source/version fields in its body.
The receipt counts toward the output character budget. Compare the receipt hash
on later pages/searches with the first page's hash before combining results.

`read('./film/edit.otio')` remains the ordinary raw text read, including existing
encoding and dedup behavior; it does not parse OTIO. Derived reads default to 200
lines and support ordinary 1-based `offset`, `limit`, and `flag: 'n'`. Each page
caps output at **200 lines / 48,000 characters**, even with a larger requested
limit, and returns a next `offset` when incomplete. They reject list mode and
encoding overrides. They are not writable files. Edit the source `.otio`, not a
derived path.

Each call parses the bounded source once, builds a lightweight O(nodes) index,
and opens only the requested view. List views emit one compact record per line
inside a JSON array, so skipped list records do **not** need serialization to
reach a high offset. Full small views are JSON; partial pages are line excerpts.
Overview remains constant-size regardless of clip count. Track views index only
direct children. No per-track descendant filtering or serialization of unrelated
views happens on a read.

An individual compact record is capped at **16,000 characters**; an oversized
or excessively deep authored object is replaced with an explicit omission record
and its source JSON pointer. Node summary names/URLs are capped at 512/2048
characters; schema/kind/track-kind strings at 128; active-reference keys and
transition labels at 256. Raw source reads retain all authored values/metadata.
Timing numbers and RationalTime value/rate pairs are not rounded.

`search({handler:'glob',query:'**',path:'./film/edit.otio'})` lists view references;
a view path can narrow the scope. `grep` in an OTIO view uses **literal** matching
(not regex), and returns path/line references matching `read` on that same view.
Search uses 0-based result `offset` and 1–100 result `limit`, as elsewhere.
`include` is not supported. Search does not require ripgrep for these views.
Glob supports `*`/`?` without evaluating a caller-supplied regex and never opens
view content. Grep opens views lazily and stops after the page plus one lookahead
match. All search queries are capped at 256 characters. Each search additionally
caps scanning at **128 opened views, 2,048 lines/paths, 256,000 characters** and
output at 48,000 characters. The first exhausted budget stops the scan with an
explicit **not exhaustive** notice; narrow the view path/query rather than
interpreting an empty budget-limited result as absence. Result-offset pagination
does not bypass the scan budget. Search never builds all matches before slicing.

## Time and analysis boundaries

The environment-independent parser is `src/shared/otio-model.ts`; the existing
`app/src/otio-model.ts` entrypoint re-exports it. Preview and VFS therefore use the
same supported schema, placement, trim, active-reference and warning rules.
Projected `start`, `end` and `duration` are seconds, not exact frame counts. The
reported composition rate is the shared parser's selected rate, not a claim that
all source media has that rate. Authored `RationalTime` value/rate pairs, source
ranges and the authored timeline preserve source precision, including fractional
rates; consumers must not round them to the composition rate. Transition hard-cut
and unsupported effect warnings remain visible; this is not full OTIO evaluation.

The source is bounded to 8 MiB, and the shared parser enforces its existing
structure/depth/time validation. A read opens one regular file, bounds bytes,
checks file metadata before/after, hashes and parses the captured content. It
never opens target media, follows URLs, probes file existence/durations, runs
ffmpeg/ffprobe, decodes video, or computes waveforms/thumbnails. A URL in `media`
is only authored data, not a capability or permission to access that URL.

## Locality and permissions

Workspace selection is resolved through the existing `filesystem.read` target
resolver before dispatch. Ordinary relative source paths use the resolved cwd,
not Project Home. These views do not create a workspace or change filesystem
permissions; they have the same local source access surface as ordinary `read`.
Traversal in the derived suffix is rejected before path normalization.

**Child and LayerFS derived reads/search are not implemented.** They fail
explicitly before any Main source access, without fallback. Raw `.otio` reads
retain the existing executor routes. This is intentionally not remote parity;
it needs a bounded full-source snapshot transport and executor-side permission
coverage before enabling remote derived views. These local parser/route tests do
not establish live multi-device or release readiness.
