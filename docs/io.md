# Frontend I/O panels and adhoc backends

The I/O feature connects browser devices and user interaction to an ordinary
agent-started service. It does **not** add a script interpreter, embedded
processing engine, provider loop or sink graph. The agent uses existing execution
and process tools to start a service in Python, Node, or any suitable language.

```text
existing exec/process tools → adhoc service on a loopback WebSocket
                                      ↕ open/ready, event/ack, asynchronous outputs
                              application backend relay
                                      ↕ existing HTTP gateway
browser I/O panel → microphone/camera/screen/file/form + trusted human controls
```

The browser needs no cross-port CORS configuration. The panel definition contains
only version, title, purpose, loopback endpoint, sources, finite limits and initial
UI. Business logic, external API calls, dependencies and output paths belong to
the adhoc service. Its process runs with normal host permissions; capture consent
does not certify that code or control its subsequent filesystem/network behavior.

## Agent workflow

The loadable tools are `io_capabilities`, `io_run` and `io_surface`, invoked through
`invoke_tool`. The [I/O skill](../src/skills/builtin/io/SKILL.md), available as
`read("v:skills/io")`, covers authoring. The
[connection reference](../src/skills/builtin/io/sdk.md) specifies `shadow.io.v1`.

The I/O skill's recording/capture/form description is listed directly in the
default skill summary, rather than hidden behind a tools category. When a task
needs fresh user input (for example, a noise sample or pronunciation recording),
the agent should request it inside the conversation instead of building another
application. An explicit request to develop a recording app is still a development
task; it is not forced into this flow. Browser automation remains available for
existing websites and explicitly requested separate web applications. If the
I/O client or device is unavailable, the agent should explain that limitation
and ask before substituting a separate browser implementation.

1. Discover connected browser clients, available first-party sources and panel
   controls. There is no STT/HTTP/business-processor catalogue.
2. Start a local service using existing execution tools. Verify readiness and
   retain the ordinary process handle.
3. Publish a complete panel definition with the service's loopback `ws`/`wss`
   endpoint and bounded capture. Creation is `awaiting_consent`, not capture.
4. Preparation connects the relay: it sends `open`, the service replies `ready`.
   Only a trusted human Start acquires browser sources.
5. The service acknowledges each ordered input promptly and sends backend-driven
   UI/status/previews/files asynchronously, independently of the input ACK.
6. Finish stops capture, sends `end`, and waits for backend `done` while processing
   continues. Cancel/close terminates the link, **not the backend process**.

Tool access is bound to the runtime project/logical session and rejects remote
workdirs. Status returns compact connection/run state; `includeDefinition:true`
returns the complete connection definition. `outputs` pages registered file
references, never raw media. Endpoint/source/budget changes need a new immutable
run and new consent; backend-driven controls can change processing state without
changing device authorization.

## Conversation experience

Capture requests appear inline with the agent's requesting reply. The card shows
the purpose, source, finite duration and primary Record/Start action. Connection
preparation is automatic while the conversation is visible; preparation never
grants device access. Endpoints, budgets, revisions and full diagnostics live in
collapsed Details rather than a separate I/O sidebar.

The same card shows live levels/video, backend controls, processing and results.
Completed captures stay with the conversation; older results outside the loaded
segment appear under Earlier captures. Navigating away does not destroy the
capture owner: a compact status with return/stop controls remains until the user
returns. Closing or reloading the application still stops capture.

The microphone selector lists browser-visible audio inputs without requesting
permission just to enumerate them. Labels may remain unavailable until permission
is granted. Input devices can be chosen before recording and changed during an
active recording; a failed change retains the previous input. Switching does not
renew capture permission, reset duration/data budgets, or create a new backend run.
Live switching currently covers standalone microphone sources with Web Audio,
not camera-embedded or screen/system audio. The existing AudioContext keeps the
PCM output sample rate stable and the recorder keeps a single container across
switches; late replacement permissions are released after cancellation.

## One small reusable example

[microphone.py](../src/skills/builtin/io/examples/microphone.py) is a standalone
Python WebSocket service, not a special product feature. It accepts mono signed
16-bit little-endian PCM with the browser's actual sample rate, displays an RMS
level/caption, receives threshold changes from a backend-driven input, and writes
a valid WAV to the path supplied by `--output`.

The caption means above/below threshold, not speech transcription. On `end`, the
service finalizes the WAV, sends an absolute-path artifact message, then `done`.
On disconnect it closes any partial WAV without claiming completion. Existing
files are never overwritten. Its finite 16 MiB PCM budget is ordinary example
logic; the service remains listening until the process tool stops it.

The example requires only the `mic` source. Its threshold input sends a control
ID without `sourceId`; standalone controls do not require an additional form
source. Any explicit UI `sourceId` must match a declared source, otherwise the
client stops the run with a diagnostic identifying the node and missing source.

Browser failures retain their bounded diagnostic in the run's `error` field,
including named device errors such as `NotAllowedError` or `NotReadableError`.
The same error is available in panel Details after reload and through `io_run`
get/status. A disconnected backend alone does not establish a permissions issue;
inspect the reported cause rather than guessing.

Install Python 3.10+ and `websockets>=13` through the ordinary environment tools,
copy the example into the chosen workdir, and run:

```powershell
python -m pip install "websockets>=13"
python microphone.py --output "C:\chosen\recording.wav" --port 8765
```

Use a real chosen directory and ensure it exists. The accompanying
[Python tests](../src/skills/builtin/io/examples/microphone_test.py) replay the
protocol with an in-memory socket and verify ACK ordering, controls, exact WAV
bytes, cancellation and errors. They need no WebSocket package or device.
The tool tests separately exercise a real loopback WebSocket mock service.

## Lifecycle and limits

- Current first-party inputs: microphone, camera, screen/window capture, file
  selection and form controls. Availability depends on the browser/OS and actual
  permission. API presence is not consent or proof a device works.
- Raw media payload <=1 MiB, encoded input <=2 MiB, bounded 8 MiB buffering.
  Binary packets can carry a <=16 KiB metadata object alongside base64; both
  decoded media and metadata count toward the run input budget.
  Default ready timeout 5 seconds; ACK timeout 30 seconds. ACK confirms receipt,
  not completed processing. A slow service should use its own bounded queue.
- Approved duration stops sources; up to 5 seconds drains final capture. After
  `end`, processing can continue until `done` or the default 5-minute processing
  timeout. This is not permission to keep acquiring new data.
- Backend output messages are `ui`, `preview`, `status`, `artifact`, `done`,
  `error`. A file path registers an existing file/download handle; the backend
  chooses its location and lifecycle. Do not infer an automatic output directory,
  model submission, retention deletion, or installation-wide disk quota.
- Refresh, connection loss, expired leases, device loss and restart do not
  automatically resume capture. Cancel does not kill an arbitrary service or
  retract external data it already sent.

The existing background-task UI can track I/O state. File registration is not
automatic model analysis; use normal agent tools and session workflows for that.
There is no per-frame model call introduced by the relay.

## Desktop and verification boundaries

The trusted desktop host uses asynchronous
`await window.shadowDesktop.mediaCapture.arm({runId,capabilities,durationMs})`
and receives `{expiresAt}`. It then immediately acquires declared sources, with
no backend network await in between. Expired transient activation requires a
fresh user gesture. Stop/failure/pagehide revoke the run and release tracks and
pending acquisition; revocation alone does not stop already-created tracks.

Desktop capture trust follows the verified Main document through same-document
history routing, including development conversation paths and packaged hash
routes. Reloading the current trusted route requires a fresh Start; another
same-origin document, iframe, or window does not inherit that trust or its grants.

The desktop permission handler separately permits clipboard writes from that
trusted Main document so Copy actions work without a media grant. Clipboard reads
remain denied; ordinary user-initiated paste still uses the browser's paste event.

Desktop grants are bounded to 24 hours. Screen/system audio is explicitly
unsupported; an independent microphone must be separately declared/approved,
never substituted silently.

After Start, desktop screen capture opens an application DOM dialog with screen
and window thumbnails, not an Electron message box or automatic source choice.
Select a thumbnail, then **Share selected**; Cancel or Escape denies this
acquisition. No source is preselected. The dialog supports keyboard radio
selection, contains focus, restores focus on close, and shows loading, empty,
unavailable-preview and enumeration-error states. Thumbnails stay in the trusted
desktop renderer; they are not capture frames sent to the I/O backend.

Main retains the Electron source objects. The narrow preload picker bridge sends
only validated request/offer tokens, and Main accepts only an offer belonging to
the current capture request from the verified Main frame. Revocation, expiry,
document reload, renderer loss and window close cancel a pending chooser, even
if source enumeration is still pending. Selection is revalidated against the
active grant before acquisition; the OS system-picker bypass remains disabled.

I/O and background-task notifications are system events, not unanswered user
messages. They do not expose the conversation's "Resend last message" action or
become its retry payload.

Windows Electron file/loopback single-gesture paths were exercised with fake
devices. Physical devices and macOS/Linux capture remain unverified. Synthetic
protocol/media tests do not establish those capabilities or hidden-tab realtime
reliability. The earlier inline-processing designs are superseded by this panel
and endpoint relay; their test results are not evidence for the current path.
