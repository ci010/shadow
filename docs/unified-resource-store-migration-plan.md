# 统一 Resource Store 重构记录

原始详尽提案保留在 Git 历史（`0a3e07a6`）。用户随后明确要求：

- 新建独立 worktree / branch，一次连续完成 refactor。
- 不做灰度，不添加 legacy/new owner 切换开关。
- 暂停重启后已明确恢复执行。

因此旧提案中的“仅批准 P0/P1”“分批等待批准”“灰度开关”不再是执行约束。
实现分支为 `refactor/unified-resource-store`，worktree 为仓库旁的
`shadow-unified-resource-store`；不修改原主工作区未提交的并行成果。

当前源码、模块/消费者清单、专用协议例外、commit/lifecycle 合约和新增资源规则，
参见 [Resource stores and synchronization](resource-stores.md)。

## 实现方向

- 每个 Vue app 独立 Pinia，统一 Resource Engine 负责调度、取消 generation、验证后提交、
  版本发布、共享 lease、恢复和有界缓存。
- Work、Maintenance、Workflow、Projects/Sessions、Chat、目录/统计和 BOT 读资源接入模块。
- `createSnapshot()`、`createLiveRefresh()` 和非组件 catalog facade 收敛到同一引擎，
  而不是保留另一套 legacy 调度器。
- 摘要/详情/分页分别建 key；删除旧 pool-keyed chat accessor；保留领域 wire adapter。
- 命令、凭据、文件权限、流式展示和专用分页，不强行当作普通实体 delta。
- 原有服务端协议兼容不等于灰度：本次没有双运行 owner，也不改变持久化格式。

## 验收边界

1. 同 key 多消费者共享读取；最后 release 停止请求和订阅，迟到响应不能复活已释放资源。
2. Project/auth/app 边界隔离；401/403 不以旧受保护快照作成功回退。
3. 数据和已验证 wire version 原子发布；no-op 不重建整个 snapshot。
4. 版本失效/畸形 delta 有界恢复，错误不触发自动写命令重放。
5. 维护 findings 和 usage 页按需加载；健康 LiveClient 空闲不引入普通轮询。
6. 专用 session lineage、activity overlay、chat/tool pairing 与 graph partial/full 规则保留。
7. 类型检查、构建、资源引擎/模块/领域回归测试；更大测试集与基线对比，不降低断言。
8. 分支推送并在 Windows 独立 worktree 同步，不切换用户当前工作分支。

本文件记录直接重构方式，不代表已经合并、部署、重启或完成真实运行验收。
