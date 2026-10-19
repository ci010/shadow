# Web attachment downloads

`MEDIA:<path-or-url>` is parsed by `src/utils/media-parse.ts`. The web renderer
creates an authenticated `/api/media?chatId=...&path=...` request for local files;
external URLs retain their normal link behavior.

For local workdirs, the endpoint first uses its existing workdir/private-upload
resolution. An additional **file-scoped** fallback supports durable output files:

- The web logical session must already exist in the current Project.
- The requested absolute path must be an exact `MEDIA:` attachment declaration
  in an assistant message in that session's persisted logical history. User/tool
  text, ordinary prose and fenced/inline code do not authorize a file.
- The source must be below `Shadow` in an OS-resolved Documents, Pictures, Music,
  Videos, Desktop or Downloads folder. This does not expose those folders for
  browsing, grant neighboring files, or allow arbitrary absolute paths.
- Both lexical and canonical paths must remain within the selected output root.
  A symlink/junction redirecting the `Shadow` root itself is rejected as well.
- Existing gateway authentication, Project/session resolution, workdir capability
  checks, range handling, GET/HEAD behavior and download headers remain in force.
  Remote/unavailable workdirs never fall back to Main's user folders. Explicit
  `sessionId` (SNS) media requests remain private-upload-only.

There is no general output-artifact registry in this path. The existing persisted
assistant attachment declaration is reused as the file grant, without adding a
second history format or migrating JSONL/SQLite. Consequently historical MEDIA
messages work without rewriting the original report or message. A path mentioned
only in another session, absent from retained logical history, outside these
output roots, missing, or rejected by canonical-path checks remains a 404.

OS discovery uses Windows Known Folder resolution (including redirected folders),
macOS folder resolution, or Linux `xdg-user-dir`; discovery failure fails closed.
Discovery is cached until backend restart. No runtime data migration is needed.
Deploy the updated backend and restart it normally to activate this behavior;
source changes do not repair an already running backend. No frontend rebuild is
required specifically for this route change (normal release packaging may still
build all assets).
