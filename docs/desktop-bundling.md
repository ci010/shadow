# Desktop runtime bundles

Desktop packaging uses Vite 8 (the Rolldown-backed version already used by the renderer) for the Node/Electron runtime entries. This is a Node SSR build, not a browser build: Node built-ins stay external, package dependencies are bundled, and tree shaking stays enabled. Non-minified output keeps production diagnostics readable.

## Entries and layout

- `resources/backend/dist/src/index.js`: legacy backend CLI, Main, Child, pairing, and the built-in `data-migration` command. Migration is an ordinary reachable CLI branch, not a removable asset or a separate executable.
- `resources/backend/dist/src/a2a/mcp-cli.js`: standalone MCP CLI.
- `resources/backend/dist/src/script-runtime/worker.js`: isolated VM/host-script process.
- `resources/backend/dist/src/channels/feishu-worker.js`: Feishu worker thread.
- `resources/backend/dist/src/utils/image-codec-worker.js`: image codec worker thread.
- `resources/backend/dist/src/execution/processes/{guardian-worker,posix-controller}.js`: process-tree guardian and POSIX controller.
- `resources/backend/dist/src/execution/network/proxy-preload.js`: Node preload for micro-app children.
- `resources/backend/dist/_chunks/*.js`: automatically shared chunks (protocol, guardian, SDK/client, proxy/Undici, etc.). Entries retain their existing paths, so subprocess launch contracts do not change.
- `app.asar/dist/main.js`: bundled Electron main.
- `app.asar/dist/preload.cjs`: standalone CommonJS sandbox preload. It intentionally does **not** share an ESM chunk with main: sandboxed preloads cannot load arbitrary ESM/CJS sibling files. No cross-resource Electron/backend sharing is attempted.

Compiled modules' `import.meta.url` / `import.meta.dirname` are rebased to their original compiled locations while bundling the backend. This preserves instruction assets, built-in skills/agents, child-process URLs, UI lookup and the packaged aria2 path even when the referencing code lives in a shared chunk. Instruction documents, the browser micro-app SDK, and the Windows guardian PowerShell script are copied separately. Bundled dependencies' package license/notice texts are retained in `dist/THIRD-PARTY-NOTICES.txt`; external codecs retain their original license files. Development `.ts` paths and `tsx` behavior remain unchanged.

## Dependencies that remain external

- Node built-ins, including SQLite, VM and worker_threads, come from the bundled Electron Node runtime.
- `electron` comes from Electron itself, not a copied npm package.
- `@jsquash/png`, `@jsquash/webp` and their runtime dependency closure (`wasm-feature-detect` today) remain real packages. Their browser-oriented WASM loaders resolve adjacent binaries and select portable/SIMD loaders dynamically. The package closure is copied explicitly from the installed lockfile versions; all codecs, WASM assets, manifests and licenses remain intact.
- `ws` optional native accelerators are not required or currently installed. Its pure-JS fallback is bundled; there is no required native addon to copy. Undici's built-in parser is bundled.
- User-configured MCP commands, Python/Node micro-apps, user script imports and optional audio/diffusion binaries remain external user-managed programs/resources, as before. Bundling cannot pre-discover arbitrary runtime imports. User scripts should install their own npm dependencies rather than rely on incidental backend dependencies being present.

## Build / verification

`pnpm build` still produces the checked, ordinary Node `dist/src` tree, preserving the development/CLI/library layout and existing tests. `pnpm desktop:build` and `pnpm desktop:package` now bundle that checked tree into `desktop/backend` instead of using `pnpm deploy --prod` to copy all production dependencies. Electron main/preload are built by `scripts/desktop-build.ts`; electron-builder includes their bundles/shared chunks and only the staged backend package closure. Release-manifest generation and relocated packaged verification still see the complete runtime resource tree.

Focused regression tests:

    node --import tsx --test scripts/backend-bundle_test.ts scripts/desktop-build_test.ts

These compile into temporary directories (never the current `dist`), relocate the backend outside the repository to prevent dependency leakage, import the bundled CLI, run read-only migration planning against synthetic data with Node and Electron RUN_AS_NODE, exercise the MCP help/proxy preload entries, perform real WASM conversion, and execute the isolated VM worker. Main is imported with auto-start disabled and a mocked Electron boundary; the CJS preload is executed in a sandbox-shaped VM and may require only `electron`. No current desktop/backend instance or real user data is touched by these tests. Full platform installer/signing tests remain the existing release verification flow.

Measured on the local existing Windows staging tree (uncompressed file bytes, not installer size): backend staging fell from about 47.72 MB / 7,479 files to about 7.67 MB / 123 files (including retained third-party notices); staged `node_modules` fell from 40.13 MB / 6,519 files to 1.17 MB / 59 files (only three packages). Electron main/preload output fell from 517.63 KB / 172 files to 185.09 KB / 2 files. These comparisons are indicative snapshots; source changes and lockfile versions can change the exact values.
