# Frontend I/O connection contract — shadow.io.v1

This is a JSON WebSocket protocol for an **already-running adhoc service**,
not a programming language or inline execution SDK. The agent starts the service
using existing execution/process tools. The application relays browser I/O to
it and relays its UI/status/preview/file messages back through the existing HTTP
gateway. The browser does not need cross-port CORS access to the service.

## Panel definition

```js
{
  version: 1,
  title: "Microphone panel",
  purpose: "Describe capture, processing, external use and output location",
  endpoint: "ws://127.0.0.1:8765",
  sources: [
    {id:"mic", kind:"microphone", mode:"pcm"}
  ],
  limits: {durationMs:30000, maxBytes:8388608},
  ui: []
}
```

Schemas are strict. There is **no `program` or `sinks` field**.
`endpoint` is a loopback `ws:`/`wss:` URL, <=2048 characters, with host
`localhost`, `127.0.0.1` or `[::1]`, and no username/password/fragment.
It refers to the agent-started service, not a provider/model endpoint.
Title/purpose are trimmed nonempty strings, <=160/2000 characters respectively.
`sources` contains 1–8 entries. Duration must be an integer 1000–86400000 ms;
maxBytes an integer 1024–1073741824. Choose conservative budgets for the actual
task. Full definitions and UI trees are bounded to 256 KiB.

Source IDs match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$` and must be unique.

| Source field | Values |
| --- | --- |
| `id`, `kind` | Required; kind is `microphone`, `camera`, `screen`, `file`, or `form` |
| `mode` | Microphone: `pcm`/`recording`; camera/screen: `frames`/`recording`; not allowed for file/form |
| `intervalMs` | Integer 100–60000; frame interval, not a realtime guarantee |
| `width`, `height` | Integers 64–1920 and 64–1080 |
| `audio` | Boolean, camera/screen audio where supported |
| `accept` | File picker hint <=256 characters, not content validation |

Choose device mode explicitly; omitted mode uses recording. Desktop system/screen
audio is unsupported. An independent microphone must be separately declared and
approved, never silently substituted.

## Connect and acknowledge input

During preparation, the application connects and sends:

```json
{"type":"open","protocol":"shadow.io.v1","runId":"<uuid>","sources":[{"id":"mic","kind":"microphone","mode":"pcm"}]}
```

The service promptly replies `{"type":"ready"}`. This is connection readiness,
**not capture authorization**. The trusted host still requires human Start.
Afterwards each input is sent as:

```json
{"type":"event","sequence":1,"event":{"type":"start"}}
```

Reply promptly with `{"type":"ack","sequence":1}`. Echo the exact sequence.
ACK means **received**, not business processing complete. Inputs are ordered;
the application waits for ACK before sending the next. Expensive processing
should be queued asynchronously by the service with its own finite queue.
Service outputs below are independent of ACK and may arrive later.

Default connect/ready deadline is 5 seconds; ACK deadline is 30 seconds.
Each media payload is <=1 MiB decoded, an encoded event <=2 MiB, and the relay
uses bounded 8 MiB buffering. Oversized messages, stalled ACKs and disconnects
fail the connection rather than silently buffering forever.
Binary packets may include a `value` metadata object of at most 16 KiB alongside
`base64`. Both decoded media and metadata bytes count toward the run's input
budget; metadata is not a replacement for the media body.

### IoPacket

```ts
interface IoPacket {
  type: "start" | "data" | "ui" | "end";
  sourceId?: string;
  mime?: string;
  base64?: string;
  timestamp?: number;
  value?: unknown;
  id?: string;
}
```

- `start`: once after human Start and backend acknowledgement of run startup,
  before producer data. No media body.
- Microphone PCM `data`: source ID, `mime:"audio/pcm"`, canonical base64,
  timestamp in epoch milliseconds, and
  `value:{sampleRate:<actual rate>,channels:1,format:"s16le"}`. The current browser
  producer emits 4096 mono signed-16LE samples (8192 bytes) per callback.
  This is raw PCM, **not WAV**; never assume a 16 kHz sample rate.
- Camera/screen frame `data`: `mime:"image/jpeg"`, atomic base64 image,
  timestamp, `value:{width,height}`. Store independent images separately.
- Recording `data`: ordered container fragments, with
  `value:{container:true,settings:[...]}`. Individual WebM/MP4 fragments are not
  independently playable; the service appends them in order and finalizes its
  chosen file. Do not concatenate unrelated complete files.
- File `data`: chunked base64 with `value:{name,size,offset}`. The service owns
  reconstruction, naming and output location. A picker name is not a trusted path.
- `ui`: control `id`, optional source association, and `value`; buttons send
  `true`. Validate/coerce input in the backend. Controls do not grant device access.
- `end`: graceful Finish/duration expiry stops sources, flushes final capture
  packets, then sends this event. ACK promptly; finish processing and send `done`.
  Cancel/failure may close the connection without `end`.

## Backend-driven output

Send any of these independent JSON messages over the same connection:

| Message | Meaning |
| --- | --- |
| `{"type":"ui","nodes":[...]}` | Replace the generated panel controls/content with a validated UI tree |
| `{"type":"preview","mime":"image/jpeg","base64":"..."}` | Preview bounded media; canonical base64, no data URL prefix |
| `{"type":"preview","mime":"text/plain","text":"..."}` | Preview text; exactly one of text/base64 |
| `{"type":"status","text":"Processing..."}` | Concise status, <=4000 characters |
| `{"type":"artifact","path":"<absolute local path>","name":"recording.wav","mime":"audio/wav"}` | Register an existing output file and its download handle; name/MIME optional |
| `{"type":"done"}` | Processing has completed; the run can complete |
| `{"type":"error","message":"Explanation"}` | Fail the run with a bounded explanation, <=2000 characters |

Finalize/close a file before publishing it. The backend chooses where it lives;
artifact registration is not a file-writing API. The application registers the
existing path, not a fabricated sink or inline byte result. Do not assume a
particular private staging directory or that registration moves the file.
Business logic and external requests belong entirely to the service. There is
no first-party STT/HTTP processor catalogue or prescribed model invocation.

Finish waits for backend `done` (default processing timeout: 5 minutes), while
status/previews/artifacts can continue. Cancel closes the link immediately and
does not kill the service process; manage that separately through existing tools.
The service must handle disconnect cleanup. Refresh, device loss, expired leases
and application restart do not automatically resume capture.

## UI nodes

Required `id` and `type`; ID syntax matches source IDs, and UI IDs must be unique.
Types: `column`, `row`, `text`, `button`, `input`, `select`, `table`, `canvas`,
`media`. `sourceId`, when present, must reference a declared source.

| Optional field | Shape |
| --- | --- |
| `text` | String <=4000, label/content |
| `value` | String <=4000, finite number or boolean |
| `sourceId` | Optional declared source ID; omit for standalone buttons/inputs, which send their control `id` |
| `options` | Up to 100 strings <=4000 |
| `rows` | Up to 200 rows, each up to 20 strings <=4000 |
| `min`, `max`, `step` | Finite numbers; step >0 |
| `inputType` | `text`, `number`, `checkbox` |
| `commands` | Up to 2048 drawing commands |
| `children` | Nested nodes; <=256 total, depth <=12 |

Canvas commands: `{op:"clear"|"line"|"rect"|"text",x,y,x2?,y2?,text?,color?}`.
Coordinates are finite within -10000..10000, text <=4000, color `#RRGGBB`.
`media` takes a source ID for live preview, not arbitrary HTML or a URL.
The host supplies rendering and trusted Start/Finish/Cancel controls; a backend
button can adjust processing, but cannot grant or extend capture.
