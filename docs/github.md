# GitHub collaboration

**Status:** local GitHub CLI integration for github.com. The Project workbench
supports Issue/PR links and reads, individually confirmed writes, and explicitly
subscribed follow-up. It does not implement a GitHub App, webhook listener,
repository-wide scanner, automatic push or automatic merge.

## Set up the owning Main

Install GitHub CLI on the machine running **Main**, make `gh` available in that
process's PATH, and run `gh auth login --hostname github.com` there. Restart Main
if installation changed its inherited PATH. This login is independent of the
LLM provider's GitHub Copilot credentials. A remote workdir does not move the
connector onto that workdir's device.

Open **Coord → GitHub**. Add `owner/repository` under **Repository access**.
Reading and individually confirmed writing are separate Project grants; writing
is off by default. The GitHub account must also have the relevant access on
GitHub. Disabling a repository pauses its subscriptions and prevents future
connector reads/writes and agent access to its cached snapshots. It does not
delete GitHub content, local Work or historical receipts.

A Project may link several repositories. Its grants and cached resources are
not shared with other Projects.

## Link or import

Load an `https://github.com/owner/repository/issues/123` or `/pull/123` URL.
Choose existing Work to link it, or load it without a Work link. Multiple
resources may relate to one Work, and one resource may relate to several Work
items. GitHub assignees are not Shadow session assignments.

For an unlinked Issue, **Import as unassigned Work** asks you to confirm the
accepted outcome, acceptance criteria and boundaries. It creates a
human-confirmed, unassigned Work item; it does not start an agent or publish
anything. Source text changing during editing requires another review. Retried
imports recover the original Work rather than creating duplicate tasks.

The workbench cards expose linked Issue/PR state and cached CI/review summaries.
The GitHub panel shows the read timestamp, source text, comments, reviews and
refresh errors. CI and approval summaries apply to the observed PR head, not
branch protection, mergeability or all required checks. Edits to an Issue flag
source drift but do not overwrite Work. Closing an Issue or merging a PR does
not finish or cancel local Work. **Discuss source** appends an editable
coordinator draft; it does not send a message.

Agents can discover cached resources with `read("v:github")` and inspect a
resource using the returned `v:github/<encoded-resource-id>` path. Virtual
grep/glob search works over this mount too. These reads do not contact GitHub.
The snapshot is external data, not an instruction or authorization; a successful
read can provide ordinary tool evidence, not a fabricated direct user quote.
Unpublished write drafts and integration operation state are not exposed there.

## Publish with an exact preview

**Prepare a GitHub write** supports a progress comment, reply to an original
inline review comment, creation of a draft or ready PR, and Issue closure.
Inline replies stay in their original PR discussion; they are not top-level
Issue comments, and threads are not automatically resolved.

Select the exact Work and destination, enter the text, and prepare a preview.
Preparation performs reads only. The saved preview identifies its destination,
immutable input, Work revision/sequence and, for a new PR, remote head/base
commits. Publishing requires a second confirmation. Previews expire after
15 minutes. Changed Work, removed links, changed remote snapshots or branches,
revoked grants and unresolved writes block execution until reviewed.

Both PR branches must already exist in the selected GitHub repository. This
connector neither pushes local changes nor creates cross-repository fork PRs.
Only the entered text is published, plus a hidden operation marker used for
recovery; session history is not attached. Closing as **Completed** requires
every currently linked Work to be done, checked again immediately before
sending. **Not planned** does not cancel those Work items.

GitHub does not provide a single atomic compare-and-write transaction across
these endpoints. Preflight checks narrow races but cannot lock a remote branch
or prevent another actor from editing immediately afterward. A created PR with
a subsequently changed head/base is reported with its receipt and a warning,
not automatically accepted or recreated.

## Subscribe to follow-up

Choose a linked resource, Work, eligible durable session and event kinds under
**Automatic follow-up**. The target must be its executor, manager or Project
coordinator. Saving captures the current assignment generation.

- **Record only:** records the external event without starting a model turn.
- **Queue a follow-up turn:** explicitly permits a queued model turn and its
  credit usage. It uses the existing EventService/SessionManager path.

One subscribed resource is polled every minute, round-robin. With several
resources, each is read less often. Main must remain running. There is no inbound
webhook port. Only differences between complete observed snapshots are reported;
transient changes between polls or while offline may not be observed.

Events cover source, comments, checks, reviews, state and head changes. Confirmed
connector comments do not feed back as new external comments. Repeated real
transitions are distinct occurrences. Refreshing unchanged state does not wake
the session again. Notifications carry factual summaries and a cached read path,
not external text presented as instructions. They cannot approve an Ask,
authorize publication, change an assignment or satisfy acceptance criteria.
Reassignment invalidates the saved target; review and save the subscription
again. Pause stops new observations for that subscription.

## Recover uncertain results

Writes are persisted as sending before contacting GitHub. A timeout, lost
response or interrupted process becomes **unknown**, not failed-with-no-effect.
It blocks further writes for that Work and leaves an unknown Work effect.
Never create another preview just to retry the same external operation.

Use **Reconcile with GitHub** to locate a unique operation marker. For Issue
closure, reconciliation verifies the desired current closed state and reason,
not which actor caused it. If no unique result is found, uncertainty remains.
After independently checking that no write occurred, an owner may record
verification notes and explicitly mark it **not applied**. This does not undo,
cancel or retry anything on GitHub. Clearing an effect elsewhere is not a
GitHub receipt and does not silently clear the connector's uncertainty.

Notifications also use a durable outbox. Interrupted or partially successful
delivery is **unknown** and is not automatically replayed after restart.
Check the session before dismissing it or explicitly accepting the duplicate
turn risk of **Retry delivery**. Delivery is not exactly-once.
A sent receipt confirms Session admission, not model completion. Connector and
Session persistence are not one transaction; an abrupt stop after admission can
also lose an input that the Session has not yet recorded.

## Storage and operational limits

Project Home's `github-integration.json` contains repository grants, cached
snapshots, links, import recovery markers, previews/receipts, subscriptions and
notification state. Atomic private-file writes protect against partial replacement;
the owning Project runtime serializes mutations. This is not a multi-process
database lock. Corrupt or unsupported state fails explicitly rather than being
silently reset. Back up the Project before offline maintenance; do not edit this
file while Main is running.

Limits are 100 repositories, 200 resources/imports, 2,000 links/operations,
500 subscriptions, 5,000 notifications and 64 MiB of persisted state. Historical
receipts are not silently purged. Reaching a limit requires deliberate offline
archival/maintenance, not deleting uncertain outcomes to bypass recovery.
Comment/review/status collections are bounded to 1,000 entries, and check reads
to 1,000 runs. Incomplete reads, rate limits, missing permissions and identity
changes retain the last complete snapshot with an explicit error; they do not
report a successful synchronization. Each GitHub request has a 30-second limit.

Synthetic transport and isolated renderer tests cover the integration without
publishing to a real repository. Real-account permission and GitHub service
behavior still require a deliberate owner-operated rollout.
