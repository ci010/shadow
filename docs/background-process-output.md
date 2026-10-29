# Background process output

Click a process title in Background tasks to inspect its stdout and stderr. This
is a read-only log viewer, not a terminal. stderr is marked `[stderr]`; the two
streams are snapshots, not a chronologically interleaved transcript.

While the panel and conversation are visible, the client requests a snapshot
about every 1.5 seconds. Closing the disclosure or leaving the conversation stops
these requests. Follow output scrolls to the bottom; scrolling upward or choosing
Pause following lets you read earlier text. Copy copies the displayed snapshot.

Snapshots contain at most 65,536 characters, with an explicit truncation notice.
The last inspected process stays visible after it leaves the running inventory,
including its final output. Only one inspected process is retained in the view;
inspecting another replaces it. Switching conversation or Project clears the
view's snapshot, and unmounting disposes its requests. Logs are runtime-backed,
not durable history across Main restarts. The existing background task manager
still owns task/result retention; this viewer does not add a server log archive.

The session-scoped output endpoint only accepts process IDs owned by that session
in the mounted Project runtime. It does not read arbitrary filesystem paths or
change remote execution routing.
