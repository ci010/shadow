# 统一 Resource Store / Sync Infrastructure 迁移计划

状态：提案，待确认；不是已获批准的迁移执行单。本文不改变运行时权限、BOT 发布审批或服务端授权。

范围：Shadow 第一方 Vue 客户端的服务端读状态、订阅、缓存与同步基础设施。建议采用 Pinia 模块作为 Vue 接入层，框架无关的 Resource Engine 作为同步与提交的唯一 owner。当前未安装 Pinia；本文不安装依赖、不迁移业务代码。

## 1. 目标与非目标

目标：

1. 新增服务端读资源不必重复实现 snapshot/delta、缓存、失效、恢复和生命周期。
2. 默认只请求所需 projection；摘要、列表、详情、分页、流分别建模。
3. 同一 scope 的多个消费者共享一份状态、一个 reader、一条订阅归属。
4. 数据与版本在验证成功后原子提交；旧响应、乱序事件、切换 Project 不会污染状态。
5. 网络字节、解析/校验 CPU、响应延迟、渲染次数、缓存容量都可测量。
6. 分阶段替换，保持现有界面、授权、逻辑/物理 session 语义及命令行为。

非目标：

- 不是把所有 API 改为 WebSocket，也不是把所有 GET 一律 delta 化。
- 不是全量数据常驻浏览器、一个巨大 Pinia store、全局实体数据库或离线优先改造。
- 不统一聊天 token 流、二进制、上传下载、文件权限租约为普通集合 patch。
- 不引入自动重放写命令、跨资源分布式事务或数据库持久化格式变更。
- 不以全站 store 迁移为理由重做 UI、权限模型、BOT 发布或设备执行链路。

## 2. 当前实现与可复用资产

以下是当前源码入口，不是需要全部重写的清单。

| 能力 | 源码 | 迁移策略 |
| --- | --- | --- |
| App 内共享 LiveClient、按 host 池化、卸载释放 | `app/src/composables/useLiveClient.ts` | 保留传输与 app 隔离，作为 engine 依赖 |
| Project 共享 sessions/activity/work、lease 与可见性 | `app/src/project-live-state.ts`、`app/src/composables/useProjectLiveState.ts` | 提取通用 registry/scheduler，兼容已有 composable |
| 串行读取、失效合并、暂停/终止 | `createSnapshot()` in `app/src/project-live-state.ts` | 先做行为等价提取，再优化 |
| SSE 多 topic、ready/replay/reconnect | `app/src/live-client.ts` | 不创建第二套 SSE；通过 adapter 接入 |
| 订阅与 HTTP 首次加载竞态 | `app/src/initial-live-snapshot.ts`、`app/src/live-resource-refresh.ts` | 必须保留 readiness gate 和有界 fallback |
| 条件请求与摘要 delta | `app/src/projects.ts`、`app/src/session-summary-snapshot.ts` | 首先保留为 protocol adapter |
| Session graph 的 partial/full 规则 | `app/src/session-graph-snapshot.ts` | 保留领域合并策略，不能当任意 patch |
| Work/Maintenance snapshot-v1 | `app/src/snapshot-reader.ts`、`src/shared/snapshot-{wire,server}.ts` | 试点协议 adapter，不直接定为永久通用协议 |
| Workflow full/delta/noop 与顺序 | `app/src/workflows.ts` | 保留顺序与结构共享语义，后迁移 owner |
| Chat 专用有界历史缓存 | `app/src/chat-history-snapshot.ts`、`app/src/readonly-history-snapshot.ts` | 最后包装，不先重写 wire |
| Maintenance 摘要/报告详情 | `app/src/knowledge-maintenance.ts`、`app/src/knowledge-maintenance-details.ts` | 保留按 report ID 懒加载 |

`app/src/main.ts` 有多个 Vue root，包括主应用、ChildWorkspace、恢复/认证等入口。因此 global 应解释为“一个 Vue app 与当前认证边界内的共享机制”，不是 ES module 单例，更不是跨安装、跨登录用户的缓存。

当前工作区还有并行开发的 Workflow/BOT 改动。每阶段实施前重新核对 HEAD、dirty files 和 owner；不以本文中的文件现状覆盖并行成果。

## 3. 推荐架构与唯一 ownership

```text
服务端领域服务 / 持久化
    -> Resource Read Model（projection + scope + schema + revision）
    -> HTTP snapshot/delta/conditional read；现有 LiveClient 通知
    -> Protocol Adapter（decode / candidate / validate）
    -> Resource Engine（key / lease / schedule / recover / commit / budget）
    -> Pinia module facade（readonly selectors + actions）
    -> composable / component

UI 草稿、选择、展开状态 -> 独立 UI module，不写入服务端事实
写命令 -> 授权后的 command API -> 明确失效或服务端事件 -> Resource Engine
```

### 3.1 各层责任

- **服务端 Read Model**：定义允许暴露、真正需要的字段；授权后读取；生成可复用的版本与变更信息。
- **Protocol Adapter**：把 legacy JSON、ETag/304、snapshot-v1、Workflow delta、Chat stream 转成 engine 能处理的结果；不能自己再建一份长期状态/订阅。
- **Resource Engine**：一个 resource key 的唯一状态与同步 owner；提交包含 value、resourceVersion、generation、freshness 的整体状态。
- **Pinia facade**：提供 Vue 响应式访问、模块化 actions、selector 和调试；不再实现第二套 fetch/cache/patch。
- **组件**：获取 lease、表达可见性和查询参数、读取 readonly state、调用命令；不直接维护服务端事实的副本。

建议 `app/src/resources/` 放框架无关 engine，`app/src/stores/` 放 Pinia facade，`src/shared/resource-sync/` 放无 Node/Vue 依赖的 wire contracts，服务端 read-model/版本管理仍由所属业务模块持有。目录名在 P1 ADR 中定稿，不能为了统一导入 backend service 到 renderer。

### 3.2 Pinia 的选择

建议引入 Pinia，但不把“装上 Pinia”当迁移完成。每个 Vue app 独立 createPinia；只在需要资源的 root 安装/初始化相应 owner。模块可按 project、work、maintenance、workflow、sessions、chat 划分；模块内通过 registry 按 scope 建资源，而不是为每个 Project 动态创建一堆永久 store。

不要同时维护 engine.value 与可修改的 Pinia data 两份权威副本。Vue facade 订阅 engine commit 并暴露 readonly view；如需镜像响应式引用，由 facade 内唯一发布函数更新。禁止组件 `$patch` 服务端数据。

## 4. 必须先冻结的通用合约

### 4.1 ResourceKey

至少包含：normalized installation/host、auth generation、Project ID（若适用）、resource name、projection/schema version、canonical query、实体/session/report ID（若适用）。

- 查询规范化只排序明确无序的字段，不重排业务有序数组。
- 密钥、token、密码不进入 key、日志、DevTools state。
- 列表与详情、不同 filter/page、轻量 graph 与完整 graph 不共用版本。
- 登录变化使旧 generation 失效；Project 切换阻止旧 scope 的响应写入新 scope。是否清除仍被其他可见 Project 使用的缓存，由 lease 而非全局清空决定。
- 运行时用户/授权上下文变化要触发边界失效；resourceVersion 不是授权凭据。

### 4.2 明确三种版本

1. **Live replay cursor**：传输层消费到哪里，用于重放。
2. **Resource version**：某个 key 的服务端读模型版本，用于 delta base。
3. **Command concurrency revision**：写入时的乐观并发约束。

三者不可互换。另有客户端 generation/commit sequence，仅用于取消和迟到响应防护，不冒充服务端顺序。

### 4.3 统一结果语义，先适配、后统一 wire

Engine 层至少识别：snapshot、delta、not-modified、reset-required。兼容窗口内允许不同 wire，只要 adapter 映射到同一套提交/恢复语义。

- snapshot：替换该 resource 的完整投影，不代表整个数据库。
- delta：仅适用于明确的 baseVersion；支持 upsert/remove 与领域顺序策略。
- not-modified：不改变值与对象 identity；只更新 freshness/诊断信息。
- reset-required：丢弃失效 base，执行有界的重新读取。
- HTTP 304 只能在已持有相同 key 的已验证快照时使用。
- 删除、空集合、null、过滤结果移出以及分页 cursor 失效必须有独立测试。

Wire 不能直接开放任意对象修改能力。若继续支持路径 patch，需要禁止原型链遍历、校验路径/操作/大小/深度；用户文本与对象键必须按不可信数据处理。版本长度、响应体、decode 后节点数/深度应有上限。

### 4.4 标准 commit 流程

```text
read / typed event
 -> 校验请求 generation、认证边界和 resource key
 -> 解码 envelope；验证 base
 -> 在不可见候选状态应用变化
 -> 领域 schema / ID 唯一性 / 引用 / 顺序校验
 -> 按领域策略协调请求期间收到的 typed-event overlay
 -> 再次检查 generation、abort 与当前 base
 -> 原子 publish(value + version + commitSequence + freshness)
 -> 通知 selectors、记录无敏感内容的指标
```

- 候选失败不前进版本、不泄露半成品；有限一次重取 snapshot，持续失败进入可见错误，不能循环拉取。
- 无变化不产生新的 data identity；变更保留未修改实体引用。
- 默认原子性只保证单 resource；sessions directory/activity 等跨资源协调通过显式 join/reconciler 完成，不承诺所有 module 同时切版。
- 普通 live invalidation 只是提示，不是事实更新；只有明确 schema/顺序语义的 typed event 能直接提交。
- 同一资源单飞；读取中重复失效合并为最多一个跟进读取。取消一个消费者不能取消仍被其他 lease 需要的共享请求。
- 不把远端慢请求串成无限队列；有超时、取消和退避，复用现有连接恢复机制。

### 4.5 生命周期与错误

建议状态包含 `idle/loading/ready/refreshing/stale/error/forbidden/disposed`，数据就绪与连接状态分开。UI 可以在刷新时保留仍获授权的旧值，同时标明 stale；不能用旧缓存掩盖 401/403 或 Project 不匹配。

- acquire -> 计数 + 按策略激活；release 幂等；active/visible 独立于组件是否仍挂载。
- 最后活跃 lease 释放后停止读取/订阅；可有短暂缓存保留期，按 bytes/entries/TTL 淘汰。
- 同一 host 仍由现有 LiveClient multiplex；不按 store 开 SSE。
- 健康连接空闲期零周期 HTTP；断线 fallback 有界、带退避，且仅覆盖活跃资源。
- 401 进入认证恢复；403 清除/遮蔽受保护值；404 是资源终止或领域缺失；409 根据领域视为过期报告/并发冲突；429 尊重 Retry-After；5xx 有界重试。不得将全部错误解释成“版本错了，再拉全量”。
- 登出、auth generation 变化、app 卸载清除受保护内存与订阅。默认不持久化到 localStorage/IndexedDB。

### 4.6 集合、分页、明细与流

- 稳定 ID + entries 与 order 分开；顺序是服务端权威还是客户端派生需逐资源声明。
- 不做自动的跨投影 entity merge；缺省字段可能表示“没有返回”，不能覆盖详情已有字段或被误认为已授权。
- 分页 key 包含 filter/sort/cursor；cursor 失效后明确重取，不把两版页面拼成完整集合。
- 大 findings/history 不因为共享缓存而自动预取；summary 与 detail 独立 lease/budget。
- 聊天 stream 采用专用 adapter，保持 segment、request ID、tool-call/result 配对、历史与 metadata revision 的现有语义。

## 5. 服务端配套：不能只有客户端 store

每个可同步资源需要一份登记：owner、授权、projection/schema、key、读模型版本、稳定 ID、delta/失效方式、排序、分页、cache budget、命令失效边。

优先级：

1. 先减少不需要的字段、按需加载、分页。
2. 没变化不要传内容：已有 ETag/304 可继续使用。
3. 集合变化小且频繁时提供 keyed delta；变更很大时直接 snapshot。
4. 最后再评估字典编码/HTTP 压缩。编码是传输选择，不是领域 schema。

当前 snapshot-v1 在刷新时仍序列化/计算 hash，并可能生成完整 packed snapshot。网络下降不代表 CPU 下降。后续评估按业务 revision 复用序列化结果、记录增删改索引、读模型缓存；基于实际 profiling 选用，不先引入数据库级 CDC。

服务端历史缓存必须按 Project/资源隔离、有界、可淘汰；重启/淘汰/未知 base 返回 snapshot。所有读取仍先经过授权；缓存命中与版本有效不代表已授权。若允许跨用户共享读模型缓存，必须证明同一投影授权等价，否则分区。

## 6. 写命令与读同步

- 写命令保留独立 typed client、服务端校验/授权与确认流程。
- 首期不做通用 optimistic write；允许按钮 pending、显示已提交/未确认，不伪造权威事实。
- 命令成功通过明确定义的 affected resource keys 或现有服务端事件失效；不要全部 store refresh。
- 失败保留编辑草稿；网络断开但可能已执行属于 outcome unknown，先查结果，不自动重放。
- 后续只有具备幂等键、并发 revision、领域补偿语义的命令才考虑 optimistic layer；它与 server base 分离。

## 7. 分阶段迁移与验收门

每阶段单独 PR/提交，可独立关闭。实施前重新盘点源码和并行 owner。任何阶段不通过门槛，不推进下一批资源。

### P0：盘点与基线（参考 2–3 人日）

交付：资源登记表、GET/订阅 owner 清单、命令失效图、旧协议目录、代表性 HAR 和 CPU/内存基线；不记录 token 或正文。覆盖多组件共享、切换 Project、隐藏 tab、断线恢复、大会话目录、大 findings、聊天流。

门槛：每个首批资源明确当前 reader、消费者、scope、响应字段用途和缓存上限。不能仅靠 grep fetch 数量推断重复请求。

### P1：ADR 与接口契约（参考 2–3 人日）

交付：Pinia/engine ownership、key/version/commit/error/lifecycle 合约，resource registration API 草案，协议兼容矩阵与回滚开关。明确是否引入 Pinia；推荐引入但不让它承担网络协议。

门槛：用 Work、Maintenance、Workflow、Session summary、Chat 五种实例验证合约可表达；不要求它们同一种 wire。先避免大型泛型 DSL。

### P2：提取基础设施，行为等价（参考 4–6 人日）

范围：提取 `createSnapshot()` scheduler、registry/lease、commit path 与 protocol adapter 接口；接入现有 LiveClient、ready gate、app disposal。加入 Pinia app bootstrap 与薄 facade；保留原 composable API 作为 shim。

门槛：旧测试不降低断言；多 root 隔离、同 key 单飞、无变化 identity、失效合并、取消/释放、迟到响应、401/403 和预算测试通过。旧 owner 与新 owner 不得同时读/订阅。

### P3：Work + Maintenance 试点（参考 3–4 人日）

范围：接入已有 snapshot-v1 adapter；Work 引入通用 resource owner；Maintenance summary/detail 分开；组件只获取 lease 和 readonly selector。取消当前 reader 内部和外部可能重复的状态 ownership，但先保持协议不变。

门槛：N 个消费者只首次读一次；隐藏后零读取；单 session 小变化不重传全列表；Maintenance 未展开不请求 findings；report 替换、repair 后刷新、晚返回与跨 Project 通过。原 HAR 场景效果不能明显回退。

### P4：目录/统计类资源（参考 4–6 人日，按批拆分）

候选：projects/folders/knowledge catalog、automation catalog、Work completions、usage summary/daily pages、BOT 只读状态。入口包括 `knowledge.ts`、`bot-settings.ts`、`useAutomationCatalog.ts`、`useWorkCompletions.ts`、`ProjectUsage.vue`。

门槛：每批先定义小 projection 与分页 key，再去除组件重复 fetch。BOT 凭据、配置草稿和连接设置不进入公共读缓存/DevTools。Usage 不把不同日期/页面合成一个模糊列表。

### P5：Workflow（参考 3–5 人日）

范围：`workflows.ts` 的现有 full/delta/noop 作为 adapter；`WorkflowManager.vue` 去掉重复 owner；canvas 只用 selectors。必须与并行 Workflow/BOT 变更协调。

门槛：顺序稳定、选中 inspector 不跳、未改节点引用不变，enabled/control/replay 命令语义不变，delta 错误正确恢复。不得把关系视图迁移误作执行链路迁移。

### P6：Sessions directory / activity / graph（参考 5–8 人日）

范围：summary、activity、graph 统一 registry 和 commit，保留领域 adapter、join 与 overlay 优先级。导航摘要与完整实体投影分开。

门槛：现有 `project-live-state_test.ts` 的竞态矩阵全部保留；typed event 胜过旧 HTTP；未知 session 有界恢复；删除不复活；logical/physical ID、lineage、sparse joins、局部 graph 不污染全量 validator。发布前多 Project 压测。

### P7：Chat 接入（参考 5–8 人日；可独立延期）

先包装现有 `chat-history-snapshot.ts`、`readonly-history-snapshot.ts` 和 ChatTab 读取 owner；不同时重写消息流协议。上下文读取也按需独立 key。

门槛：token 流不触发全量消息重读；历史分页、物理段切换、工具配对、请求重入与取消不变；图片/base64 不被通用深拷贝/hash 反复扫描；保留有界 history cache。若 engine 抽象不能满足，就保留专用 stream adapter，不强行通用化。

### P8：默认接入规则、删除旧实现（参考 2–4 人日）

交付：新资源模板、开发文档、允许例外清单、CI 检查、迁移覆盖率报告；确认无消费者后删除旧 owner/shim/重复调度器。

门槛：第一方共享服务端读资源都有明确 owner；不再存在同资源新旧 reader 并行；新 API 审查包含 projection/delta/预算/测试。例外须有理由，不以“无 fetch 字符串”为完成标准。

估算合计约 30–47 工程人日，仅为当前盘点后的规划范围，不是交付承诺；包含实现与阶段性测试，不含排期等待和未知缺陷。P0/P1 后重估。试点之前优先串行稳定接口；之后仅独立资源批次可并行，公共 engine/bootstrap/协议由单一 owner 管理。Chat 可最后单独验收，不能阻塞前面价值交付。

## 8. 兼容、灰度与回滚

- 客户端先适配旧协议；新服务端保留旧 endpoint 输出，版本能力显式协商。未知协议不能猜着解析。
- 每个 module 可以切换 legacy/new owner，但同一 key 同时只能一个 owner。切换时释放 lease、终止旧 generation、再建立新 reader。
- 开发/测试 shadow 模式只对同一份捕获响应做两套纯 decode/merge 对比，不生产双倍 HTTP/SSE。
- 按 Work/Maintenance -> 小目录 -> Workflow -> Sessions -> Chat 顺序灰度，保存预迁移 HAR/性能数据用于对比。
- 回滚不改变服务端业务持久化；关闭该 module 新 owner，清除其内存 base，重新获取 legacy snapshot。不要把 v2 内存 patch 留给旧 reader。
- Pinia facade 可保留，回滚的是底层 adapter/owner；部署中的老客户端在兼容窗口继续可用。旧协议删除需有所有第一方客户端升级策略，不能假设桌面/移动端同时升级。

## 9. 测试与性能验收

### 必须自动化的正确性矩阵

1. snapshot/增删改/empty/null/order/noop，固定 ID 与重复 ID 拒绝。
2. base 不匹配、重启、历史淘汰、未知 schema、畸形/超限 patch，恢复有界。
3. A 请求晚于 B 返回、读取中失效、读取中 typed event、abort 后返回、切换 host/Project/auth generation。
4. 多消费者共享、释放一个不取消其他人、最后释放停止后台读取、app unmount 清理、多个 Vue root 隔离。
5. disconnected fallback、ready 前不读、replay gap 恢复、恢复后停止 polling。
6. 401/403 不显示受保护旧数据；命令 outcome unknown 不自动重放；未知资源不跨 scope 回退。
7. report 替换、分页失效、列表与详情投影隔离、session lineage、chat tool pairing。
8. no-op 引用不变、局部更新未改实体引用不变、预算淘汰正确、订阅/监听器无泄漏。

### 量化门槛

- 同一 key 同时 N 个消费者：一个 reader；健康连接空闲场景：零周期 HTTP。
- 小规模实体变化：响应量随变化规模增长，而非完整集合线性增长；顺序整体改变等例外单独记录。
- 首屏不请求未展开明细；不能用省略必要字段/错误统计换小响应。
- Work/Maintenance 当前 HAR 离线改进作为回归基线；上线后重新录制，不把离线估算冒充线上效果。
- 固定设备/fixture 记录初次、单项更新、noop 的 encoded bytes、decode/validate/commit 时间、长任务、render 次数和峰值 heap。CPU/内存容忍阈值在 P0 确定，未经基线不虚构毫秒指标。
- 总缓存预算 + 每类资源预算 + 保留期；不用 JSON 字节直接冒充实际 JS heap。循环切换 Project/打开关闭页面后内存及订阅应收敛。
- 至少 macOS 与 Windows CI010 各完成主路径运行验证；覆盖 Web/桌面及实际存在的移动端旧客户端兼容边界，不从编译通过推断产品可用。

诊断只记录 resource 名称、匿名/脱敏 scope、原因、大小、耗时、命中/恢复次数；不记录消息正文、findings 文本、凭据或完整查询敏感值。诊断缓存自身也有界。

## 10. 长期防回归机制

新资源 PR 模板要求：

- 为什么这些字段必须在此 projection 返回？是否能 summary/detail 分离？
- key / 授权 / schema / 稳定 ID / 顺序 / 分页 / 版本策略是什么？
- 哪些事件和命令使它失效？由谁读取、谁释放？
- 多消费者、noop、小 delta、大 snapshot、断线和授权失败分别怎样？
- 前后端 cache budget、CPU/字节基线与测试在哪里？

CI 可逐步限制组件直接做共享 server-state fetch、直接 patch 权威 state、私建 EventSource。允许 typed command、binary、capture/capability 和有说明的一次性读取；检查依赖/入口边界而不是机械禁止全部 fetch。

## 11. 决策与下一步

建议批准的第一阶段仅为 P0/P1：盘点、基线、ADR 和 API 契约；然后提交可审阅的 engine 设计与更准确排期，再批准 P2/P3 试点。本文本身不构成安装依赖、全站迁移或上线授权。

需要在 ADR 确认：Pinia facade 方案、兼容支持窗口、资源预算、灰度/回滚入口，以及 P7 Chat 是否纳入本轮。推荐先把 P0–P3 作为第一里程碑，其他阶段按验收结果推进。

## 12. 计划审阅补充：进入实施前需要落定的细则

1. **灰度开关**：由 app 级配置管理，按 auth generation/module 固定，不在单次 render 中漂移。切换先撤销旧 owner 的 commit 资格、递增 generation，再终止读取与订阅；进行中的写命令不因切换重发。测试必须包含切换过程中的旧 HTTP 和旧事件晚返回。
2. **事件排序证据**：直接提交 typed event 的资源必须登记 event identity、sequence、snapshot watermark 或等价的可验证规则。缺少排序证据时只 invalidation；覆盖重复、倒序、重放、watermark 缺口，不能用客户端到达时间证明服务端新旧。
3. **提交峰值**：P0 测量旧值、解码结果、候选值同时存在时的峰值；P1 规定哪些 adapter 允许全量 clone/validate，哪些必须局部合并并维持领域不变量。Chat 预算不得被通用候选构建绕过；原子提交不等于任意大的同步深拷贝。
4. **退出登记**：每个资源列出新旧 owner、剩余消费者、兼容协议、开关和关联测试。移除旧客户端 owner 与删除服务端旧 wire 是两个独立验收项；前者不必等待所有旧版本客户端退役。
5. **性能证据安全**：优先持久化统计和合成 fixture。必要的原始 HAR 仅在受控临时位置处理，不进入仓库；持久化/分享前删除认证头、cookie、敏感 query 和请求/响应正文，核验脱敏。需要正文计算的离线分析仅在内存中进行，保存结果而非正文。
