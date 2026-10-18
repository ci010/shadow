---
name: io
description: "Collect missing task input through Shadow: audio recording, microphone samples, camera/video/screen capture, file input and interactive forms inside the conversation."
core: true
metadata:
  category: tools
---

# Frontend I/O for an adhoc backend

Use this when completing a task requires fresh input from the user: listening to
a noisy fan, collecting a spoken pronunciation sample, or seeing something through
the camera. The user need not ask for a recording UI. Read the protocol, start a
service, and publish an inline capture card with `io_surface`.
Do not create a standalone HTML recorder merely to obtain missing task input.
An explicit request to build a recording app or website is a development task;
do not force that deliverable into an I/O card. Browser automation remains
appropriate for existing websites and explicitly requested web applications.
For a reusable Shadow-hosted tool, read `v:skills/micro-app` instead.
If the I/O client or a source is unavailable, report the limitation and ask before
switching to a separate browser implementation; do not silently substitute one.

Use existing execution tools to run an ordinary service in whatever language
suits the task. The I/O panel supplies browser devices and user interaction; a
bidirectional relay connects it to that service. **There is no inline program,
script interpreter, processing engine or sink graph in the definition.**

Read `v:skills/io/sdk.md` for the small `shadow.io.v1` WebSocket contract.
`v:skills/io/examples/microphone.py` is a complete Python service: microphone PCM
becomes a live level/caption, backend-driven threshold control, and a valid WAV
at a caller-chosen path. It does not perform speech recognition.

## Workflow

1. Discover `io_capabilities`, `io_run`, and `io_surface` with
   `search(query="io", handler="grep", path="v:tools")`. Read their returned contract paths,
   then call them through `invoke_tool`.
   `io_capabilities` reports connected clients, first-party sources and controls,
   not business processors. `needs_client` means the user must open the local host.
2. Write/start the adhoc service with existing exec/process tools. Bind it to
   loopback. Install its normal dependencies using those same tools when needed.
   Verify the listener is ready and retain its process handle.
3. Publish a panel with `io_surface` action `publish` (or `io_run` action `create`):

   ```json
   {
     "version": 1,
     "title": "Microphone level and WAV",
     "purpose": "Show live sound level and save microphone audio to the agreed local output path.",
     "endpoint": "ws://127.0.0.1:8765",
     "sources": [
       {"id": "mic", "kind": "microphone", "mode": "pcm"}
     ],
     "limits": {"durationMs": 30000, "maxBytes": 8388608},
     "ui": []
   }
   ```

4. Creation returns a run ID and `awaiting_consent`, **not running capture**.
   The card appears with the agent's request in the current conversation and
   prepares the connection automatically. `open`/`ready` confirms connection
   readiness. Only the user's Record/Start action acquires sources. Device
   controls belong in this card, not in a separate browser window or side panel.
5. Let the backend send controls, status and previews whenever useful, independently
   of input acknowledgements. Check `io_run get/status/list` for connection/run
   state. `includeDefinition:true` includes the connection definition; `outputs`
   pages registered file handles with `offset` and `limit` (1–100), not file bytes.
6. **Finish** stops sources, sends `end`, and waits for backend `done` while it
   finishes processing. **Cancel**, `io_run stop`, and `io_surface close` close the
   link without requiring a final result. They **do not kill the backend process**.
   Use the existing process tools to stop a service you no longer need.

Project/session identity is supplied by the runtime, never tool arguments.
Remote-workdir capture is unsupported. Changing endpoint, sources, budgets or
initial definition creates a new immutable run and requires new consent.
Backend-driven controls update interaction state, not source permissions.

## Keep responsibilities simple

The adhoc service owns all business logic, external API calls, dependencies and
output locations. Ask for or choose an appropriate output path through the
ordinary task workflow; the panel does not invent a directory or sandbox.
The service runs with its normal host permissions. Capture consent does not
certify the service's code or restrict its later filesystem/network behavior.
Explain data use and any external destination in the purpose and user conversation.

Send bounded inputs and prompt ACKs; do expensive work asynchronously rather than
blocking the transport. Keep audio/video out of tool-result text. A file reference
does not imply that a model understood the file. Use normal agent tools/session
workflows for subsequent analysis or messaging, not a model call per frame.

The Python example needs Python 3.10+ and `websockets>=13`, installed normally:

```powershell
python -m pip install "websockets>=13"
python microphone.py --output "C:\chosen\recording.wav" --port 8765
```

Materialize the resource in the chosen workdir first; `v:skills` is a read
interface, not an executable path. The output parent directory must exist.
The example refuses overwrite, caps PCM at 16 MiB, and leaves a valid partial WAV
after disconnect without claiming success. Its process keeps listening until
the ordinary process tool stops it; use a new output path for another recording.
