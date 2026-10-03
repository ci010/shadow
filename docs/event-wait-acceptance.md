# Live Actions wait and mid-run URL acceptance

This opt-in experiment asks a **real LLM** to complete a two-run workflow without
instructing it to use subscriptions, foreground waiting, or background execution.
It uses the production `SessionManager`, general-agent instructions, runtime
discovery, skills, tool importer, exec/background lifecycle, polling sources,
event delivery and session stores. The model responses are not scripted.

The original experiments use a loopback-only, disposable Actions fixture.
The separate [real GitHub mode](#real-github-mode) below uses actual workflow
runners, build artifacts and GitHub API signals.

1. Run `424242` starts in progress and completes after the configured hold.
2. Only after its success can the agent launch `second.yml` (run `424243`), once.
3. During run 2's third step, logs print an unpredictable `PROCESS_URL`.
   The agent must process that exact URL once within **60 seconds of printing**.
   Processing succeeds only while step 3 is running. Otherwise step 3 times out,
   run 2 fails, and late processing cannot rescue it.

The fixture offers status queries, a blocking run watch, current logs and a
streaming log endpoint. Brokered read-only HTTP grants reach the same synthetic
state. URL processing is enforced and timestamped by the fixture, not inferred
from the agent's final answer. First-run failure is a separate negative scenario.

## Run the local fixture

From PowerShell, using an existing standard Shadow Copilot login:

```powershell
$env:SHADOW_EVENT_WAIT_LIVE = '1'
pnpm exec node --import tsx scripts\event-wait-acceptance.ts --out .\event-wait-cold --scenario cold
pnpm exec node --import tsx scripts\event-wait-acceptance.ts --out .\event-wait-source --scenario existing-source
```

Each `--out` must be a new directory. Prefer a private artifact location, not
tracked source. Runs are potentially billable. The default model is Shadow's
`DEFAULT_COPILOT_MODEL`; `--model` selects another available Copilot model.
Temperature, thinking and reasoning effort use schema defaults and are recorded
in `prompt.json`; user configuration and role/skill overrides are not loaded.
No user workspace, configuration, GitHub repository or real workflow is modified.
The authenticated provider may refresh its ordinary login/model cache.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--scenario` | `cold` | `cold`, `existing-source`, or first-run `failure` |
| `--storage` | `sqlite` | `sqlite` or `jsonl` |
| `--hold-seconds` | `90` | First run hold; 30–180 seconds |
| `--url-timeout-seconds` | `60` | Deadline after URL printing; 1–120 seconds |
| `--timeout-seconds` | `360` | Overall evaluation deadline; 60–900 seconds |
| `--max-calls` | `30` | Shared real model-request cap; 1–100 |

`cold` begins without a producer for Actions. The agent can discover and create
a polling source, use exec, schedule cron, or delegate. `existing-source` adds
a discoverable producer for `github.actions.completed` and `github.actions.log`;
it does **not** subscribe the agent or tell it which strategy to use. Compare
these as different environments, not as a causal benchmark of the model.

## Evidence and limits

`summary.json` records pass/failure, violations, URL-to-processing latency,
first-run-to-dispatch latency, API/log read counts, model calls, observed
mechanisms, subscriptions, polling sources, dispatches,
processing attempts and idle-wait samples. `trace.json` records actual executed
tool calls/results, accepted inputs, turn facts, waiting samples and HTTP reads.
`history.json`, `model-responses.json` and `prompt.json` preserve reproducible
synthetic conversation evidence, including generated scripts.

Mechanism labels are observations: a completed foreground exec is labelled
`foreground-exec`, with `foreground-exec-wait` added when it exceeds ten seconds.
Neither label proves a particular await implementation.
Use its recorded arguments/results to distinguish watch, polling and streaming.
Background classification requires an actual managed process receipt.

## Observed simulated runs, 2026-10-04

Four real `gpt-6-astra` / SQLite trials used a 60-second first-run hold and
a 60-second URL deadline. The two final trials use schema defaults
(temperature 0.7, reasoning effort medium). The earlier exploratory trials
used temperature 0 with no effort override; they are not the same configuration.
All four met the enforced deadline, launched run 2 once and processed its URL once.

| Configuration / environment | Actual implementation | Model calls | HTTP requests / log reads | Print-to-process |
| --- | --- | --- | --- | --- |
| Schema defaults / cold | Foreground Node script: blocking run watch, then live log **stream** | 4 | 5 / 1 | 52 ms |
| Schema defaults / existing source | Foreground Node script: blocking run watch, then live log **stream** | 4 | 5 / 1 | 54 ms |
| Exploratory / cold | Background Node script: blocking run watch, then 200 ms log/status polling; continuation and completion callback | 6 | 83 / 40 | 202 ms |
| Exploratory / existing source | Foreground Node script: blocking run watch, then 250 ms log/status polling | 4 | 67 / 32 | 146 ms |

None read the event-source catalog or called `event_subscribe` / `event_source`.
The existing producer therefore did not participate. In the background trial,
the only accepted completion event was `background-task-complete`, which is
automatic background execution delivery, not an explicitly installed subscription.
The parent became idle while that script waited; the foreground trials kept
the parent in inference/tool phases.

In the schema-default existing-source trial, run 2 was launched **49.508 seconds
after** run 1 completed because the generated script had not yet been executed.
The corresponding cold trial dispatched after 79 ms. The URL processing in both
was performed by generated code, without another model round trip at URL arrival.
This demonstrates why end-to-end efficiency must measure dispatch latency and
session availability, not just the fast URL handler.

These are observations, not a statistically established preference or a causal
benefit of either environment. The low-request path already available here is a
streaming observer with a deterministic handler. Running that observer as owned
background work would additionally release the conversation while waiting.
No production instructions were changed to force that strategy.

The host timestamps are authoritative. Some exploratory final answers reported
only URL **detection-to-processing** latency, excluding polling detection delay;
the table deliberately uses actual **printing-to-processing** latency instead.

The original fixture is an agent-loop integration E2E, **not** browser/Electron or real GitHub
E2E. It composes the relevant production services without the full Main host,
channels, project catalog, Work enforcement, learning or remote-device runtime.
The real model runs real host-capable tools; the prompt's directory boundaries
are not an OS sandbox. Only synthetic test context is supplied.

The mid-run log channel is deliberately test-specific. Do not assume GitHub's
REST run/job log archive endpoints expose step logs while a job is running.
A real deployment needs an independently verified live-log path (for example
an explicitly configured workflow callback), plus appropriate authentication.
Passing this fixture does not establish that integration.

The fixture/verdict tests run offline without model access:

```powershell
pnpm exec node --import tsx --test scripts\event-wait-acceptance_test.ts
```

## Real GitHub mode

The manual-only [`event-wait-live.yml`](../.github/workflows/event-wait-live.yml)
workflow has two independently dispatched phases sharing a fresh request UUID
and one exact commit:

1. `ci` runs the real Shadow event tests and `pnpm build`, creates a SHA256
   receipt for the backend files, and uploads the backend/receipt as a one-day
   Actions artifact.
2. After CI succeeds, the **agent** dispatches `cd` once. Its three steps are
   checkout, download/verify the successful CI artifact, and the URL deadline
   gate. This is an artifact-CD acceptance, not an installer/mobile release.
3. The third step creates a transient, non-production deployment in the
   `shadow-event-wait-acceptance` environment, prints its processing URL, and
   publishes the exact URL/timestamps in a dedicated Check Run.
   Its monotonic 60-second deadline starts at printing, **before** publishing
   the signal. Only an exact correlated acknowledgement observed before that
   deadline passes; late acknowledgement cannot change the runner result.

Check Run output is an explicit real GitHub API signal side channel. It is
**not** a simulation and **not** a claim that GitHub REST exposes live step
logs. The workflow has no push/PR trigger, signing, production deployment or
release publication. Only the CD job receives `checks: write` and
`deployments: write`; other permissions are read-only.

[`event-wait-github-acceptance.ts`](../scripts/event-wait-github-acceptance.ts)
reuses the same production session/tool/event composition as the original
runner, now with an injected Project `EvalBridgeRuntime`. Its narrowly scoped
`github_actions` capability uses the existing host `ghTransport`; it does not
extract a token or send one to the model/script. A Node-shell script can call it
through the real `invoke_tool` SDK. This verifies **host GitHub login brokerage**,
not arbitrary access to the Project credential store or `secretRef` grants.

Processing the printed URL means downloading the actual CI artifact, verifying
the exact repository/request/run/commit and every receipt file hash, then
acknowledging the correlated test deployment once. It does not merely POST a
success-shaped dummy receipt. Both writes reject duplicates/uncertain retries.
HTTP polling-source requests are also restricted to this pair's read routes.
The harness observer records evidence but never dispatches CD or processes
the URL for the agent; its reads are labelled separately from agent reads.

Start CI yourself with a new UUID and wait only for its ID to appear, **not**
for it to finish. Then run:

```powershell
$env:SHADOW_EVENT_WAIT_LIVE = '1'
pnpm exec node --import tsx scripts\event-wait-github-acceptance.ts `
  --out <new-private-directory> --repository ci010/shadow --branch session `
  --ci-run <actual-ci-run-id> --sha <exact-40-character-commit> --request <uuid>
```

The real runner accepts `--model` and `--timeout-seconds` (900 by default).
The branch is deliberately restricted to `session`. Do not move the branch
between CI and CD: both phases must run the exact supplied commit. The prompt
explains available authenticated capabilities but does not choose event
subscription, foreground waiting or managed background execution. Capability
`watch`/`watch_signal` implement asynchronous API polling, not CPU-blocking waits.

In addition to the original conversation artifacts, `github-evidence.json`
records the exact GitHub identities, labelled API calls and authoritative runner
deadline receipt. A pass requires the actual CD completion and gate receipt,
not the assistant's success claim. Runner elapsed time measures print-to-observed
acknowledgement; GitHub `created_at` timestamps have lower precision. Run
`updated_at` is used as the observed completion timestamp, not a sub-second
measurement of the final job finishing.

The agent executes against the **local current Shadow runtime**, while CI builds
the specified **remote committed revision**. The harness is still not a full
Main/Electron/UI E2E, and host Node execution is not an OS sandbox.
Only specifically authorized new test files should be published; never push a
dirty checkout or existing unrelated local commits to enable this test.

Offline contract and real Project Node-bridge tests:

```powershell
pnpm exec node --import tsx --test scripts\event-wait-github-step_test.ts scripts\event-wait-github_test.ts scripts\event-wait-acceptance_test.ts
```

### Observed real runs, 2026-10-03

Both pairs used real `gpt-6-astra`, SQLite, schema-default model settings and
remote commit `0e2a23ba50edb23f3543afe358b5548ecd002e40`. The later test-files
publication additionally wires the offline acceptance tests and root TypeScript
check into CI; it does not change the URL/deadline protocol.

| Trial | CI | CD | Outcome |
| --- | --- | --- | --- |
| First | [37141576596](https://github.com/ci010/shadow/actions/runs/37141576596) | [37141661138](https://github.com/ci010/shadow/actions/runs/37141661138) | CI succeeded; harness rejected GitHub's normalized Check Run URL, so no URL processing occurred and CD genuinely failed its deadline |
| After harness fix | [37141760427](https://github.com/ci010/shadow/actions/runs/37141760427) | [37141848447](https://github.com/ci010/shadow/actions/runs/37141848447) | Both succeeded; runner observed acknowledgement **17.721 seconds after printing**, within 60 seconds |

GitHub Actions rewrites a custom Check Run's `details_url` to
`https://github.com/<repo>/runs/<check-id>`. The harness now accepts that exact
canonical URL as well as its originally supplied run URL, while still checking
the external UUID and payload's exact CI/CD/deployment identities. The first
failed trial is retained; it is not counted as a success or explained away as
an agent strategy failure.

In the successful trial, the agent first read the Node skill and capability
contract. It generated an `exec` script with `shell: "node"` and
`timeout_ms: 1000`, which became managed background execution
`bg:0a05f795fc124879`, then installed a continuation:

```typescript
const ci = await invoke_tool({ name: 'github_actions', args: { action: 'watch', run_id: ciId } })
// The generated script checked CI conclusion and commit before dispatching.
const cd = await invoke_tool({ name: 'github_actions', args: { action: 'dispatch' } })
const signal = await invoke_tool({ name: 'github_actions', args: { action: 'watch_signal', run_id: cd.id } })
await invoke_tool({ name: 'github_actions', args: { action: 'process', url: signal.signal.url } })
// The actual script then verified final CI/CD conclusions and the runner receipt.
```

This excerpt describes the observed sequence, not a ready-to-run replacement
for the saved script's error checks. Both waits were asynchronous host API
polling via the actual Node tool bridge, at three-second configured intervals.
The parent was idle while the background script waited. No model round trip was
needed between URL arrival and processing: the script immediately called the
host capability, which downloaded and verified **850 real backend files** and
acknowledged the deployment once. CD was dispatched once.

The runner printed at `17:48:25.521Z`, accepted the observed acknowledgement at
`17:48:43.243Z`, and had a deadline of `17:49:25.521Z`. The final receipt is the
successful [Check Run](https://github.com/ci010/shadow/runs/111257787270).
The agent made seven model calls. The recorded API trace contains 79 requests,
including labelled harness-observer reads; it is not an agent-only request
count. CD was created about five seconds after the run API's observed CI
completion timestamp. There were no subscriptions or authored polling sources;
the only accepted event was automatic `background-task-complete`, **not**
`event_subscribe`.

The first trial instead chose direct foreground `github_actions.watch` calls.
These two observations do not establish a fixed or statistically preferred
agent strategy. Both used the host's real GitHub authentication, not anonymous
access, and neither received credential values.
