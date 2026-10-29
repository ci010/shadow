## Content, progress and failures

Organize the first view around the primary input, result and action, not a large
setup manual. Keep required first-use setup compact and actionable beside the
affected control; collapse optional routing tutorials and technical details.
Do not hide active-device/permission state or immediate stop controls. Check
both fresh first-use and ready states at desktop and narrow sizes: the main
workflow should not require scrolling past a wall of explanation or settings.
No horizontal overflow alone is not a useful layout acceptance test.

Keep meaningful results separate from transient progress. A poll, heartbeat,
empty input chunk or unchanged observation is not a new result/history entry.
Update a compact status in place; do not repeatedly append diagnostic cards or
scroll meaningful content away during idle periods. Bound result history without
letting status-only events evict useful results. Test an extended idle interval,
not just a populated screenshot. Record time/state, let the interval elapse while
doing other checks, then inspect again; do not sleep through an MCP deadline in
one browser evaluation. Put optional diagnostic details in the advanced
area rather than the main result stream.

Report failures with the affected operation/resource, what remains unavailable,
and a safe next action. Do not put raw child-process stderr, stack traces or
machine paths in the primary error message. Preserve bounded technical details
separately without credentials. Decode subprocess output deliberately: when Node
consumes Windows PowerShell output as UTF-8, configure that child process's
`[Console]::OutputEncoding` and `$OutputEncoding` as UTF-8 first. If Node sends
UTF-8 JSON to that child's stdin, also set `[Console]::InputEncoding` before
reading it. For non-ASCII `.ps1` source under Windows PowerShell 5.1, use
`write` with `encoding: "utf8-bom"` on full writes; stdout encoding does not
change source-file decoding. Python backends start in UTF-8 mode; for isolated
Python workers use `python -I -X utf8` (isolation ignores `PYTHON*` environment
variables). Keep JSON stdio explicitly UTF-8 and diagnostics on stderr.
Test a non-ASCII round trip across both directions, not ASCII-only
fixtures; never change system-wide code pages. Exercise a failed operation and
its retry UI, including non-ASCII diagnostics.
