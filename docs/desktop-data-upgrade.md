# Desktop data-layout upgrade

The desktop checks a Main data folder read-only before backend startup, Main configuration writes, or Main agent initialization. This applies to saved launch profiles and to a legacy folder selected in first-run setup. Fresh folders and valid version 1/version 2 migration receipts continue normal startup without replaying migration.

When a supported legacy layout is detected, Desktop displays **Upgrade your data folder**. Stop every other Desktop, Main, service, and development process that can write to the folder, then explicitly acknowledge this and select **Start upgrade**. Desktop cannot prove that legacy processes are stopped. The upgrade moves data; it does **not** keep a complete old snapshot. Make an offline backup yourself beforehand if needed.

Desktop runs the bundled backend with Electron's embedded Node runtime (`ELECTRON_RUN_AS_NODE=1`), not an external Node/tsx installation. The backend reports inventory, staging, publishing and completion phases. Counts represent entries or top-level roots, not a synthetic byte percentage or time estimate. A successful child exit is followed by read-only layout validation before normal startup continues.

Failures remain on the upgrade screen with diagnostics and a retry/check action. Interrupted locks, invalid receipts, and unsupported roots block automatic upgrade. Retry rechecks eligibility; Desktop never deletes old data, clears locks, resets setup, or rolls back automatically. Keep writers stopped and use the bundled CLI for diagnostics and explicit recovery described in [Data migration](data-migration.md). Ordinary runtime retry/reset does not run the migration; reset is refused while the layout is not ready.

The CLI remains available for recovery. The UI uses `data-migration --data-dir <absolute-root> --copy --offline --progress`; `--copy` is the historical command name and the upgrade itself uses the backend's move-based implementation. Rollback is a separate explicit offline operator action.
