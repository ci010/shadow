# 按网络 → 进程 → 组件理解托管服务器

**阅读范围：**下面重排的是 2026-10-14 那次架构解释，不是新增验收结论。真实 Minecraft 本地生命周期已有测试；数据库、对象存储与云供应商在相关验收中仍有替身。公网玩家入口和生产云集成不能据此算完成。

```answer-html
<div class="answer-callout" data-md>**先分清三种边界：**网络边界描述谁与谁通信；进程边界描述谁独立存活和退出；组件边界描述谁负责哪件事。一个组件不一定是一个独立服务。</div>
<section class="answer-grid">
<article class="answer-card">
<h3>① 用户设备</h3>
<div data-md>Launcher / 网站向 API 发 **HTTPS 控制请求**。

Minecraft 客户端向游戏主机发 **游戏 TCP 流量**。

这两条路径不同；游戏流量不经 API 或 SSH executor。</div>
</article>
<article class="answer-card">
<h3>② 控制平台</h3>
<div data-md>API、生命周期状态机、计费与 SSH executor 是**职责组件**，不等于四个常驻进程。

平台持有已接受的业务状态，决定当前证据允许哪个下一步。</div>
</article>
<article class="answer-card">
<h3>③ 游戏主机</h3>
<div data-md>短 SSH 请求进入固定 helper；持久操作与受限游戏 workload 不依赖连接保活。

systemd / cgroup 管生命周期；watchdog 管离线租约期限；runner 监督 Java / Minecraft。</div>
</article>
<article class="answer-card">
<h3>④ 对象存储</h3>
<div data-md>helper 直接通过 HTTPS 恢复、上传并校验快照。

存储持有不可变字节；**API 中的 canonical 指针**才代表平台正式接受的世界版本。</div>
</article>
</section>
```

## 三条网络路径

| 路径 | 关系 | 不意味着 |
| --- | --- | --- |
| 控制 | 用户 → API → 短 SSH → helper | SSH 在线才开服；连接丢失就停止 |
| 游戏 | Minecraft 客户端 → 游戏端口 | 当前隔离网络内测试已验证公网接入 |
| 数据 | helper ↔ 对象存储 | 世界必须经 Launcher 或 executor 中转 |

## 游戏主机的进程边界

```answer-html
<section class="answer-flow">
<article class="answer-card"><h3>短连接入口</h3><div data-md>**sshd → helper CLI**

接收或查询持久操作。断线后查原任务，不假定副作用没有发生。</div></article>
<article class="answer-card"><h3>持久管理工作</h3><div data-md>**systemd 操作进程 + watchdog**

操作进程做 prepare / restore / stop / snapshot。watchdog 独立监督有限租约，不自行延长计费授权或发布世界。</div></article>
<article class="answer-card"><h3>受限 workload</h3><div data-md>**runner → Java / Minecraft**

cgroup 覆盖完整进程集合；Java 只应写游戏 mutable 目录，不能写管理 journal、租约或密钥。</div></article>
</section>
<div class="answer-callout" data-md>**不是进程：**journal 是受保护的主机事实记录；canonical 是平台持久状态里的版本指针；helper 内的 storage、授权校验、host backend 是模块，不是各开一个 HTTP 服务。</div>
```

## 谁能证明什么？

| 责任方 | 能提供的事实 / 职责 | 不能单独声称 |
| --- | --- | --- |
| Java | 世界内容、游戏行为 | 数据已正式发布 |
| runner / helper | 本次保存、退出及主机观察证据 | 平台已经接受该版本 |
| systemd / cgroup | 完整工作负载边界是否清空 | 正常保存成功 |
| storage 模块 | 不可变对象的传输与字节校验 | canonical 已更新 |
| API | 证据接受、canonical 发布、释放授权 | 未经观察的主机事实 |
| provider | 准确 VM 的创建 / 释放 | 世界一定可恢复 |

```answer-html
<div class="answer-callout" data-md>**进程退出 ≠ 正常保存 ≠ 世界冻结 ≠ 快照上传 ≠ canonical 发布。**

正常 Stop 需要跨越这些证据边界，最后才允许释放准确的 VM。任何单个退出码或清理成功都不能替代整条链。</div>
<details>
<summary>当时强杀测试为什么仍是 PARTIAL？</summary>
<div data-md>已经证明 SIGKILL 后完整进程边界清空；但主机退出事实 → API 冻结状态 → 对象存储无新上传 → canonical 不变的负例链尚未完成直接验收。

这是当时证据缺口的解释，不是当前生产状态承诺。</div>
</details>
```

**不要混淆自带服务器模式：**它是 Launcher 通过直接 SSH/SFTP 帮用户操作自己的机器；托管模式则由平台持有业务状态、主机提供执行事实、对象存储持有可恢复数据。停止自带 VPS 的 Minecraft 不会自动释放 VPS 或停止供应商计费。
