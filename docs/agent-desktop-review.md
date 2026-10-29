# agent-desktop 桥接审核记录（真机验收待进行）

## 当前交付边界

- 既有 `ComputerDesktop` 的 list/bind/observe/foreground/release，以及全部 11 种动作已有实际实现；未开放上游其余命令。
- Windows 默认且唯一 backend 为 native agent-desktop，无 backend 环境变量开关；缺失/不兼容 addon 或 guard 直接失败，不回退。Windows 构建缺产物时给出明确的 native 构建命令。
- 当前宿主未重启、未热切换。没有通过 exec 执行真实 UIA、截图、键鼠输入或启动交互测试应用。
- 已完成构建、模拟和无 UI 加载验证，**不等于真实窗口截图/输入验收通过**。下一步必须由用户正常重启宿主后，通过 computer-use 普通工具选择窗口并测试动作；高后果确认使用现有 agent ask，不使用专用逐动作审批 UI。

## 实际产物

所有位置均在当前仓库 `C:\Users\ci010-4090\Workspace\shadow` 内；不是私有会话临时目录。

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `integrations/agent-desktop/artifacts/win32-x64/shadow-agent-desktop.node` | 1310720 | `D666F5BEF1B773D641F8B5B5ADA687BB7516E8DEE506B0CE728741110108B578` |
| `integrations/agent-desktop/artifacts/win32-x64/shadow-input-guard.exe` | 30208 | `2B9DC3F8D36C0A009D6A9789DA81E8273B7C0A0193E90B8BD47AC71D206C1B2F` |
| `integrations/agent-desktop/artifacts/testing/shadow-computer-fixture.exe` | 10752 | `8D3945199891F1B2CD6883D20A3236E68F0310A8CDA414DA8E80B66BAAE1E31E` |

完整 backend 实验快照已构建到
`integrations/agent-desktop/artifacts/native-backend-win32-x64-v3/dist/`。
其中 native/guard 副本 hash 与上表相同；隔离加载通过。它不是签名的 Electron 安装包。
测试窗口只进行了 `--identity` 元数据验证，**没有启动其 GUI**；用户可手动打开后测试。
测试窗口显示在任务栏，含普通/只读/过长输入、假密码、禁用按钮、按钮/复选框/列表及指针区域；不输出键值或文本日志。

## 复用与安全适配

- 上游固定 revision：`5a2c9ad43e269164a8adc8978a733c40b1d38a8b`，Apache-2.0、0.10.1。
- 截图调用真实 `SystemOps::screenshot(ExactWindow)`。已审查 Window 分支 WGC 失败仅落到该 HWND 的 PrintWindow，不走桌面 CopyFromScreen/BitBlt。
- 普通动作使用真实 WindowsAdapter 内的单 UIA pattern 扩展，避免上游 dispatcher 的 Legacy/物理回退和 Select 搜索链。
- 密码未知/秘密先剪枝；内容读取前立即短路。观察含 TextPattern 有界 fallback、真实 bounds、readonly/原始长度判断；offscreen 内容仍参与 SHA-256 指纹但不 advertise actions。
- root/element runtime ID、进程创建时间与窗口前后校验；120 秒快照、单次消费、防重放；每次 dispatch 前检查 deadline 与不可重置取消标志，dispatch 后失败/取消为 `outcome_unknown`。
- 上游低层 SendInput 不提供等同原 guard 的独立 marker/hooks/owner-death 清理，因此 AOT 复用既有 C# guard。没有运行时 C# 编译或 shell launcher；保留 windows-input.cs 和 AOT 构建。
- Node child 主 stdio isolate 可独立调用快速 `cancelInput()`；真正 COM/UIA 留在专用 owner 线程。命名事件仅取消，不能提交输入。guard 使用私有 stdio、独立 EOF/父死亡监听和 held 输入释放。
- native 验证 guard metadata、严格按方法校验返回值、单条有界队列；损坏/未知响应 poison 实例，不继续复用。

## 验证结果

### 默认唯一 native 路径变更后

- `src/execution/computer/*_test.ts`：26/26，无 skip；缺 addon 测试隔离生产 worker，仅发 release，不执行 UIA。
- asset/backend-bundle 回归：4/4；asset/AOT guard/fixture 组合：7/7（有重复，不累加）；relocated 完整 backend 构建成功。
- `pnpm exec tsc --noEmit`、`pnpm build`、`git diff --check` 通过。
- 默认 dist 包含 addon 与 AOT guard，不含 windows-host.cs 或旧运行时编译 launcher。
- 删除 windows.ts、windows-host.cs 及旧 backend GUI 测试；保留 stdio-transport.ts（强制传入 worker launcher）及 fake guard/stdio 回归。
- 首次 fake guard 测试因环境失效 MSVC LIB 路径失败；仅测试编译子进程清空 LIB/LIBPATH 后通过。
- 保留 windows-input.cs、AOT 构建及 testing/window.cs fixture 来源。未重启或执行真实 UI。

### 此前全桥接验证（历史批次）

- 最终组合 focused Node 测试：**54 pass / 1 skip / 0 fail**（55 项）。
  - skip 是已有 native 时避免真实 observe 的 missing-addon 用例；缺 addon/guard 的构建诊断与真实 relocated worker 缺文件失败另有测试，均通过。
  - 包含：全部动作的 JS/TS schema 等价性、协议校验、并发/超时/取消、准确 receipt、审批前不 dispatch、未知结果撤销 grant、cleanup drain、生产 release-only 无 UI ABI 往返。
  - 包含：实际 csc 编译、既有 fake-input 环境 40+ 断言、guard `--identity`、idle guard 的 EOF/自有父进程死亡退出。没有 begin/execute lease 或 OS 输入。
  - 包含：relocated worker 无外部 zod、实际 Node/Electron-as-Node addon identity/ABI、guard metadata、缺失 addon fail-closed、完整 backend 打包回归。
- Rust root 纯/无 UI 测试：**29/29**。
- Node 原生源码回归：**10/10**。
- Windows x64 release `--locked`：成功。
- 实际 addon identity、impossible-method ABI、cancelInput、owner shutdown：成功。
- focused strict TypeScript：成功；相关共享文件 `git diff --check` 成功。
- 不是全仓测试/typecheck 声明；没有 ARM64 或真实 provider/输入/截图验收声明。

命令见 `docs/agent-desktop.md` 及 native README。唯一人工启动步骤也在那里：正常退出旧宿主，在仓库 PowerShell 设置 loopback Vite host，运行 `pnpm dev`；手动打开测试窗口，再通过 computer-use 测试。

## 源文件清单

### 新增 TypeScript/JS 与文档

- `src/execution/computer/agent-desktop.ts`
- `src/execution/computer/agent-desktop-worker.js`
- `src/execution/computer/agent-desktop-actions.js`
- `src/execution/computer/agent-desktop-actions.d.ts`
- `src/execution/computer/agent-desktop-actions_test.ts`
- `src/execution/computer/agent-desktop_test.ts`
- `src/execution/computer/factory.ts`
- `src/execution/computer/factory_test.ts`
- `scripts/agent-desktop-assets.ts`
- `scripts/agent-desktop-assets_test.ts`
- `scripts/agent-desktop-input-guard.ts`
- `scripts/agent-desktop-input-guard_test.ts`
- `scripts/agent-desktop-fixture.ts`
- `scripts/agent-desktop-fixture_test.ts`
- `docs/agent-desktop.md`
- `docs/agent-desktop-review.md`

### 新增独立 native 集成

以下均位于 `integrations/agent-desktop/`：

- `.gitignore`、`Cargo.toml`、`Cargo.lock`、`build.rs`、`package.json`
- `LICENSE`、`NOTICE`、`README.md`
- `src/lib.rs`、`src/owner.rs`、`src/windows.rs`、`src/input.rs`
- `patches/shadow_observe.rs`、`patches/shadow_gate.rs`
- `scripts/fetch.mjs`、`scripts/build.mjs`、`scripts/identity.mjs`、`scripts/source-test.mjs`

`.upstream`、`target` 与生成 artifacts 均被该目录 gitignore 排除；不将整份上游/构建缓存打包。

### 共享文件最小增量

- `src/runtime/main/host.ts`：factory import 和构造点。
- `src/runtime/main/project-runtime.ts`：同上。
- `scripts/backend-bundle.ts`：独立 worker 入口、JS 扩展支持、精确 native asset staging。
- `scripts/backend-bundle_test.ts`：relocated worker 的无 UI 协议检查。

这些文件原有其他用户改动保留，未覆盖/回滚；根 `pnpm-lock.yaml` 未修改。没有创建 Git commit。

## 运行依赖与未验证事项

- 已获用户授权通过官方 Rustup 安装当前用户工具链；rustc/cargo 1.99.1，Rustup 1.29.1。持久变更为 `.cargo`、`.rustup`、用户 PATH 和默认 stable x64 toolchain。
- 构建沿用 VS2022/MSVC/Windows SDK；运行需受支持交互 Windows/UIA/D3D、VCRUNTIME140、.NET Framework 4.x（System/Core/Web.Extensions）。
- 上游 Apache 声明、Shadow C# guard 的既有代码来源分开记录；完整第三方 license 审计、签名/正式发行未做。
- 真机截图、每种 provider pattern、所有实际键鼠动作、真实 held 输入时取消/人类接管仍需受控验收。无 UI 测试不能替代这些结果。
