# Project 因果对齐：目标、设计取舍与后续演进

状态：**设计意图与未来工作文档，部分基础已实现；不是全部完成的功能清单。**

记录日期：2026-10-10。本文保留 Work/Initiative 实验、用户讨论与第一轮实现
评估后的判断。后续实验应更新状态和证据，不应把尚未验证的目标改写成既成事实。
当前操作以 [Tools and automations](tools-and-automations.md#shared-work-notes-and-the-project-canvas)
和 [Architecture](architecture.md) 为准。

## 1. 最初要解决的两个问题

Work/Initiative 的初衷不是管理 agent，而是服务两个不同的使用者：

1. **给 agent 一个共享的思考脚手架。** 保存目标、当前计划、发现和下一步，
   让自己、parent 和其他 worker 能回看，不必重新理解长对话。
2. **让用户知道整个 Project 在做什么。** 用户能快速掌握目标、进展、风险与
   待决事项，必要时再深入某条分支，而不是阅读所有 session 的往来消息。

两者应共享事实，但不必共享同一种信息密度。不能为了生成一个好看的 dashboard，
要求每个 worker 持续写面向用户的完整报告；也不能因为取消强制记账，
就让用户失去全局视角。

**最终目标：用户有总览，想看时能深入，重要提问发生在这个大背景之中。**

## 2. 旧实验说明了什么

对一个真实、多 session 协作样本的复盘，观察到了以下坏模式：

| 坏模式 | 对工作的影响 | 应保留的教训 |
| --- | --- | --- |
| Work 回执反复附带完整 schema、定义、历史和说明 | 有限上下文被管理信息占据，当前变化反而不突出 | 写入返回小回执；按需读取当前内容和历史 |
| 同一个结论在笔记、消息、汇总、验收说明间重复转述 | 没有逐字重复，也会产生语义噪音和确认循环 | 共享状态是事实来源，消息只用于需要对方改变行动的事 |
| 用户已经说不需要 grader，分支仍继续围绕 grader 工作 | 旧实现方案逐渐变成了隐含需求 | 保留用户目标与方案之间的区别，显式撤销错误前提 |
| 已经送达的结果仍被反复索要 | 关注点从业务结果偏移到管理收据 | 不把定期回报、确认收到和重复验证当作默认协议 |
| 普通调查被未建单、未 adopt 或通用 unknown-effect 状态阻塞 | agent 绕工具、补表单，用户被卷入非业务问题 | 笔记不做通用执行门禁，恢复留给拥有该操作的机制 |
| 底层障碍直接上抛给用户 | 用户既没有背景，也不知道它是否值得解决 | 先判断问题改变哪个上层目标或方案，再在该处提问 |

这些是一个样本里的定性与计数观察，不是随机对照实验。
不能把所有协调调用都算作浪费；必要的证据、权限检查和不确定操作恢复仍有价值。
也不能仅凭第一版测试通过，就声称已经降低真实 token 成本或注意力漂移。

## 3. 核心洞见：对话需要匹配抽象层次

用户提出的“力与速度”比喻是本设计的出发点：

- 用户的动机和期望结果，类似推动工作的 **force**。
- agent 从目标推导出的方案和具体任务，类似具体的 **velocity**。
- 给 worker 分配工作，相当于让它沿一个方向前进。
- 当 worker “撞墙”时，墙可能只是这个方案的障碍，不是用户目标的障碍。

这不是要求给任务计算数学上的“阶”，而是提醒我们：
**同一个问题，在不同抽象层次上可能需要完全不同的答案。**

例如：

```text
用户目标：理解一次发布的影响
  └─ 方案：收集并比较评估数据
      └─ 假设：必须先有评分 grader
          └─ 障碍：grader 暂不可用
```

错误升级：“grader 不可用，要等，还是花时间修？”

合适的升级：“这份发布报告需要评分证据，还是现有 token 指标已经足够？”

如果用户只要 token 指标，正确动作可能是撤销 grader 前提，而不是继续为
这堵墙找绕路。parent 应先尝试在已有目标和权限内替换方案；只有真实影响
用户目标、范围、取舍或需要额外授权的问题，才应升级给相应决策者。

因此，每个问题需要区分：

- **发生位置**：哪条技术分支遇到了问题。
- **决策位置**：用户或 parent 的选择实际改变哪个上层目标或方案。

因果图表达的是**可修改的工作推理**，不是已经证明的因果真理。
“选用这个方案”“确实需要这个依赖”“目前假设如此”必须能够区分；
agent 的解释不能冒充用户的原始需求。

## 4. 已选定的设计原则

### 4.1 三种信息各有责任，不建设三套相互同步的账本

| 信息 | 谁维护 | 用途 |
| --- | --- | --- |
| 目标、方案、推理关系、当前笔记 | parent 与 worker 按职责共同维护 | 解释为什么做、已知什么、下一步是什么 |
| 运行事实：正在执行、等待回答、结束、失败 | runtime 提供 | 说明实际发生了什么，不依赖 agent 手填状态 |
| 面向用户的总览与渐进展开 | 原生 UI，必要时辅以 HTML 展示 | 在合适的抽象层次理解和介入 |

Work 保持为可选共享笔记；Initiative 是根节点及其后代的聚合视角，
不再维护另一份需要同步的目标和状态。Session 是对话与执行容器，
不必与 Work 一一对应。

执行结束、笔记标为完成、用户接受结果，是三个不同事实。
没有笔记的 session 也要可见，不能以“出现在总览里”为理由强迫建单。

### 4.2 Parent 与 worker 分担语义维护

**Parent 负责结构和影响：**维护目标与方案的关系、跨分支依赖、对用户意图的
解释，评估 worker 的发现是否需要改变上层方案，以及问题该在哪一层提出。

**Worker 负责局部事实：**维护自己的发现、当前计划、下一步和产物；
当局部假设、范围、依赖或障碍发生实质变化时，标记其影响，而不是重写整个
Project 的叙事。

**Runtime 负责已知事实和可靠更新：**保存版本、来源和执行状态，通知界面，
处理并发冲突及过时问题，不替模型编造业务推理。

Project coordinator 不因此成为所有 session 的实际 parent，也不获得
代替所有人回答问题的权限。界面位置、汇报责任和真实回答权必须分开。

### 4.3 更新默认安静，重要变化才触发行动

普通笔记更新只刷新共享状态和 UI，不唤醒 parent，不要求确认收到。
有实质影响的变化才触发提醒；同一待处理影响的连续更新应合并，
接收者读取最新状态，而不是逐条消化进度广播。

不把 parent 周期性巡查所有 worker 当作默认维护策略。
也不要求 worker 每隔若干步填表或更新 HTML。判断标准是
“这条信息是否会让接收者采取不同动作”，而不是“多久没汇报了”。

合并也可能掩盖新的独立影响，通知失败也可能让已保存的事实没有被看到。
这些需要专门评估；不能为了少发消息而把未送达说成已处理。

### 4.4 当前笔记可更新，历史与不确定性不可伪造

笔记是当前工作状态，不是每次都追加一份完整报告。
审计历史、问题原始路径、用户原话与版本来源单独保留。

上游改变后，下游应明确显示“影响尚未评估”，不能自动写出一份看似最新的总结。
更新局部进度不等于重新评估；记录评估结论也不等于获得操作许可。

新的问题 ID 不能掩盖旧前提仍未评估的事实。反过来，
有待评估的前提也不应禁止调查、讨论或无关的已授权工作。

### 4.5 HTML 是表达手段，不是新的控制面

[Anthropic html-plan](https://github.com/anthropics/claude-plugins-community/tree/main/html-plan)
以及讨论中提到的 “answer by HTML” 给出的启发，是渐进展开和把决策放在相关
论点旁边，而不是单纯把 Markdown 换成网页。

我们要解决的是**长期、多 session 的共享理解**，不只是一份一次性计划。
因此倾向结构化因果节点加局部自由展示，而不是多人并发改写一张巨大的 HTML。

自由展示必须让用户看清前提、证据和不确定性。回答、审批、修改与权限仍由
原生控件和后端协议承担；HTML 不能执行工具、伪造审批或绕过真实操作恢复。

## 5. 截至记录日期：已经做了什么

第一版已连接可选笔记、goal/approach/task/finding 节点、三类推理关系、
Project 因果总览、无 Work 的运行活动、上下文问答和隔离的只读 HTML 展示。
普通执行不再依赖建单、adopt 或 checkpoint；真实能力与 owner 审批边界保留。

后端生成问题的根到源路径，前端把原生问题放在决策节点旁；
用户可以修改祖先前提、讨论前提或自行回答。目标与分配变化会让相关旧问题失效。
新问题保留未评估标记，已评估结论也进入 worker 的有界上下文；
祖先再次改变后，旧结论不再作为当前评估展示。

这是基础设施，不是自动的“全局理解者”。**尚未实现或证明的部分：**

- 自动从所有 session 抽取并长期维护正确的因果结构。
- 自动选择每次提问的合适抽象层次，或证明某个方案仍符合用户意图。
- 对既有历史 session 自动回填可信的因果链。
- 让 agent 自由改写整张 dashboard；当前 HTML 是节点里的局部展示。
- 自动完成影响分析、替换过时方案和协调所有分支。
- 真实模型长期协作中的降噪、节约成本和对齐改善。

上述语义工作目前仍依赖模型、使用指导与人的判断。
版本匹配只能证明记录没有过时，不能证明推理是对的。

## 6. 自动评估带来的进一步认识

以下是 2026-10-10 本地确定性评估的记录，不是以后版本的自动保证：

| 场景 | 观察 | 含义 |
| --- | --- | --- |
| 40 次等长进度更新，附大 HTML | 初始探针的 prompt 只增长 1 个字符，来自版本号；HTML 不重复进入审计事件 | 机械性的上下文膨胀可以通过实现控制；字符数不等于 token 成本 |
| 13 层推理链 | 问题保留完整路径；日常 prompt 只展示 5 层并注明省略 | 可以兼顾有界上下文与可追溯性 |
| 20 个未选定的 assignment | prompt 只显示 3 个，不会自动猜测问题归属 | 后续补上总数、展示数、省略数与发现指引；遗漏风险仍需实战评估 |
| 改掉“必须有 grader”的前提后重新提问 | 旧问题失效，但新问题仍可能带着旧分支目标 | 补上未评估警示与评估结论；没有声称宿主能自动判断语义正确性 |
| parent 已记录评估 | 只有保存结论还不够，worker 必须在后续上下文中看到 | 补上日常 prompt 中的评估结论 |
| 原生界面回归 | 测试依赖冷启动曾导致空白或请求停滞；修正依赖准备后连续三次完成全流程 | 区分测试环境故障与产品缺陷，不通过增加宽松断言掩盖问题 |

该轮最终有 110 项相关逻辑／集成用例通过，覆盖双 session 存储、反复修改目标、
草稿保留与问答生命周期；另有完整渲染流程验证。测试使用确定性 provider 和
合成输入，**没有证明真实 LLM 会主动写笔记、选对提问层次或及时放弃错误前提。**

## 7. 未来工作：按实验结果推进，不按功能清单堆叠

### 优先方向 A：真实模型协作评估

选一个本来就值得完成、需要 parent 与两三个 worker 的有界任务，
使用正常启动说明，不额外要求频繁更新，也不人工替它维护一棵漂亮的树。
先运行真实模型加可控工具环境，再进入有明确授权边界的实际任务。

覆盖成功、缺信息、真实依赖失败、错误假设、用户中途改变目标等情况。
特别检查“用户明确说不需要 grader”之后，是否仍在修 grader 或重复询问。
成功应由任务结果与用户理解共同定义，而不是是否调用了指定 Work 工具。

### 优先方向 B：低成本、可信的语义维护

根据实验区分问题来源，再选择干预：

| 观察到的问题 | 优先探索 | 不应直接采取的办法 |
| --- | --- | --- |
| 很少更新，有用上下文缺失 | 在分工、重要发现、方案变化、交接时提供更自然的写入机会 | 恢复每步强制记录 |
| 更新很多，但用户看不懂 | 调整层次、默认摘要与渐进展开；消除重复叙事 | 再加一个总结 agent 不停重写 |
| 问题总停留在技术 A/B | 改善 parent 对目标影响的判断，提示反事实方案和前提修正 | 仅要求更长 brief 或机械向上转发 |
| 目标已改，执行仍沿旧方案走 | 验证评估结论是否进入有效上下文、是否转化为局部计划变更 | 把所有分支暂停等统一批准 |
| 多任务被忽略 | 评估更好的发现、聚焦和优先级提示，保留其他任务可见性 | 每轮注入全部任务全文 |
| 通知合并导致遗漏 | 评估独立影响的识别、失败可见性与必要的恢复路径 | 对所有更新无差别广播 |

后续已实现事件触发的辅助整理 MVP：独立、无工具的观察者从新输入、真实分工和
最终报告生成带来源的未分配 Work，不要求 worker 主动记账。它不是周期性巡检，
没有历史回填，也没有证明能长期维护正确的因果树。配置、成本边界和人工编辑保护
见 [自动观察机制](tools-and-automations.md#automatic-observation-mvp)。
历史导入、完整自动因果抽取和自动选择提问层次仍属于候选方案。
任何自动推断都必须显示来源和不确定性，不能把猜测写成用户意图。

### 优先方向 C：用户总览是否真的支持介入

用真实用户任务验证：不翻聊天记录，是否能回答“为什么做、正在做什么、
哪里卡住、需要我决定什么”。用户应能从总览进入具体证据，再回到目标层，
不迷失在 session ID、工具日志和任务状态中。

继续探索结构化节点与 HTML 的比例、跨分支共享依赖、局部修改体验、
长时间离开后的恢复和历史对照。是否需要更自由的 canvas，应由理解成本和
实际交互收益决定，而不是把“自由 HTML”本身当作交付目标。

### 后续方向 D：真实长期运行与恢复

验证休眠、重启、压缩上下文、worker 更换、并发编辑、通知未送达、
已结束但有未决影响的任务。旧历史若导入，应区分当时的原话、事后推断和
未知关系，允许不完整，不能补出一条虚假的完整因果链。

## 8. 评估方式与停止条件

未来真实模型评估至少记录：

| 维度 | 观察信号 |
| --- | --- |
| 结果质量 | 是否完成用户目标，是否做了不需要的工作 |
| 用户理解 | 不读全部对话能否解释待决事项；是否需要额外补背景 |
| 协调成本 | 管理工具与消息占比、重复语义、确认循环、上下文字符／token 与耗时 |
| 提问层次 | 是否定位受影响的目标，是否把可自行替换的方案升级给用户 |
| 变化传播 | 修正目标后有多少过时动作或重复问题；无关工作是否仍能继续 |
| 总览可信度 | 重要活动覆盖、信息陈旧程度、未关联／未评估／未知状态是否如实呈现 |

使用同类任务、相同模型配置、可比输入和工具条件做多次运行，报告原始结果、
范围和失败样本。旧 session 可用于设计反例，不能直接当作严格的 A/B 基线。
额外 summarizer 的调用和人工补录也应计入成本，不能把成本转移当作减少成本。
在获得基线前，不凭空设置一个“节省百分比”承诺。

每轮机制迭代可在以下条件下停止：已发现问题有针对性回归，关键场景稳定，
没有依靠恢复通用门禁来通过测试，剩余未知和失败被明确记录。
这意味着“值得进入下一阶段验证”，不意味着“设计永远没有问题”。

真正的产品成功标准是：
**agent 能正常工作，用户能理解并纠正工作方向，而双方不必为了维持这份理解
再做一份同样昂贵的协调工作。**

## 9. 本轮用户总览要求与第一版落地（2026-10-11）

**来源：本轮用户讨论，不是模型自行增加的记账要求。** 用户进一步明确：
基本 dashboard 应该先回答过去发生了什么、有哪些话题、每个话题最新／最终状态；
复杂话题再展开内部结构，包括人或模型作出的决策。用户随后指出顶部
“已固定的操作”占用太多空间，并反馈 Quick Actions 获取数据失败。
这补充了第 1 节的用户总览目标，没有撤销前文关于权限、来源和执行／结果区别的原则。

当前实现：

- 默认 Overview 是包含结束记录的话题历史，不再默认打开工作因果画布。
  优先按已保存 Work 根节点及显式后代组织；没有显式链接的会话单独显示为
  **以会话为线索的话题**，明确不是经过验证的语义话题划分。
- 卡片首屏展示根节点现有报告／目标、记录状态、最近时间和关联会话执行状态；
  展开查看局部摘要、关系类型、来源、阻碍与下一步，仍可打开原有详情、
  Canvas、Board、Graph 和对话。执行结束或笔记 done 都不是用户接受结果。
- 展开时才读取关联会话的原生决策记录，保留问题、原始片段／请求 ID、回答时间；
  区分人的回答、上级模型回答、超时默认项、未答问题、无回答关闭与失效记录。
  模型笔记中的“选定方案”不冒充原生已回答决策。历史按会话展示，不声称
  一个会话内的所有决策都属于同一个语义话题。
- 用户待答事项与内部影响评估／未知副作用恢复分开计数。后续用户反馈“不知道 review 要填写什么”后，内部项进一步移到无数字催办的 Agent 诊断入口，默认不出现在首页；诊断打开后仍默认收起，说明由 Agent 复核、用户无需填写，按钮仅“查看笔记”。
- 调查确认自动观察器会因为最终报告重新措辞 objective 而提升语义 revision，
  并且子笔记的进度更新会重写祖先 basis。现在仅新用户／上级指令允许重写目标；
  report-only 更新保留目标和旧 basis，既减少虚假目标变化，也不把真实人工目标变化
  自动当作已经复核。已有记录不批量清除或伪造复核结论。
- 固定操作改为紧凑条带，没有固定操作时不占位；失败保留紧凑错误和重试入口。
  前端现已接受真实本地 FolderRecord 合同中省略 kind 的形状，仅缺省 kind
  解释为 local，显式 remote 或未知 kind 不会降级成本地。

**已知边界：**没有回填历史会话的语义话题、最终报告或模型日常隐式取舍；
根节点摘要可能落后于某条分支，界面显示现有记录而不是自动编造综合结论。
决策读取限最近 20 个物理片段／100 条原生记录；截断或无法读取明确标记。
没有证据的用户接受状态不推断为已接受。Quick Actions 的 kind 合同差异可用
真实 FolderRegistry 输出复现，但本轮没有读取用户运行数据，不能保证截图中的
每一次获取失败都只有这一原因。测试是合成数据与本地组件回归，不代替真实模型
长期运行或用户理解验证。

### 9.1 后续用户反馈与本轮语义总览（2026-10-12）

**来源：用户明确指出话题列表散乱、需要整体任务分类，Overview 与 Dashboard
目的重复；随后明确表示旧 UI 是实验品，无需保留冗余入口，并要求主动触发整理。**
据此，默认入口现在只有 Dashboard，按关注目的分组 → 独立话题最新状态 → 可展开
证据／内部结构／原生决策历史。主视图只保留总览与类似 issue 的 Board；因果结构与
Graph 是总览内部的局部折叠展示，不再提供独立 Canvas／Graph 或“结构工具”入口。
话题内部展示已保存角色、supports／requires／assumption、上级及跨话题依赖；缺失
角色或关系明确标注，不把模型分组当作因果证据。紧凑固定操作与默认隐藏的 Agent 诊断保留。

- 原有每会话观察调用增加可选的语义分类、共同目的和近期关注动机推断；每条推断
  引用当前输入证据 ID／物理片段。最多提供 8 条既有分类／目的短文本帮助稳定命名，
  不注入其他会话全文、不检查文件／运行目录。类别按共同目的而非固定技术 taxonomy。
- 所有分类、目的、动机均明确标为**模型解释，不是已确认用户意图**；不创建新的
  work 关系、分派、权限或用户接受状态。相同推断类别仅合并展示分组，不合并话题。
  缺少推断的旧记录显示“尚未分类”，不按关键词假装做过语义理解。
- 新增“整理近期话题”按钮，界面事前说明会调用模型；打开界面不调用。用户点击才
  运行一次项目级整理（不是仅 flush 待处理事件），输入最多最近更新的 30 个现有根笔记，
  总计 32,000 字符的有界字段：目标、摘要、下一步和已记录原话（若有）。这允许整理
  已有记录，但不扫描或回填聊天历史，也不假装覆盖没有笔记的会话。
- 整理结果存入项目 SQLite 独立快照，附推断时间、输入／遗漏数量、来源 key／sequence。
  校验只能引用本次输入、每话题只能出现一次；保存前校验笔记版本。变化后显示可能
  过时，失败保留上一份快照；整理与自动观察共享单调用占用、90 秒超时与停止取消。
  后端使用现有项目路由授权、空请求体严格校验，客户端与后端都阻止并发重复触发。
- 不新增周期性／页面打开总结调用；自动观察成本仍是一版新证据一次原调用，增加
  有界提示与输出字段。主动整理每次点击新增一次观察模型任务（默认 quickModel／model，
  可由 workObserver.model 覆盖），不自动重试。关闭自动观察不阻止用户明确主动整理。

**验证与边界：**新增 schema、旧 JSON 解析／SQLite 重开、来源校验、整理重复／失败／
版本冲突、授权／输入校验、前端分组／过时标记与实际 Electron 渲染回归。
合成模型验证调用数与合同，不证明真实模型的分类或动机判断正确；用户可深入原话题
和决策证据。输入窗口外与没有记录的话题保持可见且未分类。会话 JSONL／SQLite
历史形态未改动；观察字段可选，旧 work 读取不需要迁移或昂贵历史调用。

## 10. 维护本文

未来修改需标明哪些是用户目标、哪些是已选择的设计、哪些仍是候选实验，
并记录支持判断的证据。保留失败和取舍，不把历史方案改写成一直正确。
当前工具字段、存储与权限规则只在操作／架构参考中维护；本文不另造协议。

相关入口：

- [当前 Work 与问答操作](tools-and-automations.md#shared-work-notes-and-the-project-canvas)
- [源代码支持的整体架构](architecture.md)
- [运行时协调器指导](../src/agent/types/builtin/orchestrator/AGENT.md)
- [运行时共享工作技能](../src/skills/builtin/initiative/SKILL.md)
- [后端协调回归](../src/sessions/work-integration_test.ts)
- [笔记与上下文回归](../src/sessions/work-alignment_test.ts)
- [原生界面回归](../app/src/work-alignment-rendered_test.ts)

## Current correction: integrated overview (2026-10-12)

The dashboard is now one native Project overview graph, not the old causal canvas and work graph moved into separate folds. Overview and Board are the only main work views. Focus-group controls scope the same graph without merging topic identities; group purpose/motivation remain labelled model hypotheses. Nodes use persisted work roles (goals, approaches, tasks), original saved decisions and reported results. Selecting a node shows its source, authority, time and typed incoming/outgoing relationships, with work-detail and conversation navigation instead of a duplicate raw-record wall. Decisions are loaded lazily for the selected topic's conversations; history bounds and missing segments remain visible.

Relation classes are intentionally different: parent-child hierarchy; declared dependencies; recorded purpose relations; original decision context; cited decisions; explicit reconsideration; chronological precedence; and evidenced causal influence. The last is limited to persisted applied work proposals with an exact decision reference and base/applied revisions. A decision reference alone does not prove impact. Timestamps describe last changed/reported events, not historical topic creation or a complete causal timeline. Missing history is represented as unavailable references, never invented contents. Automatic observations and reports are not human acceptance.

Organize now queues behind automatic observation with a bounded wait and independent cancellation; duplicate manual requests are rejected. HTTP pre-model rejection paths and model/overview failures carry sanitized machine codes, stages and correlation IDs and produce stage logs. UI errors translate known codes and display safe identifiers/status, not raw provider messages. Successful responses are schema-validated and rendered before the background live-state refresh. Opening the dashboard still makes no organization/model request.

Diagnosis limitation: the previously reported bare “整理失败” has no correlated organize request or model call in the examined runtime telemetry, so its actual runtime cause remains unknown. Busy rejection, hidden pre-model errors, network failure and response failures are hardened paths, not an asserted diagnosis. Source changes require the normal later application reload/release; this work does not restart the production backend or make paid model calls.

### Native canvas presentation (October 2026)

The Project overview now uses Vue Flow core 1.41.5, background 1.3.2 and controls 1.1.3, following the dedicated canvas/custom-node/handle pattern in `origin/dag-chat` (`packages/dag-chat/src/components/DagCanvas.vue`, `QANode.vue`, and `utils/layout.ts`). No branch checkout or legacy business logic was imported. Existing ownership-based layout remains authoritative: roots start horizontal; clicking or pressing Enter/Space selects and independently expands descendants downward; filtering and semantic edges do not force branches open. Pan, zoom and fit-view controls operate on a responsive dotted canvas. Compact custom cards keep detail/evidence in the selected context pane. Node dragging, connecting, edge editing and deletion are disabled: this canvas is a read-only presentation of recorded work, not a causal-graph editor. Temporal and cited-reference edges remain visually distinct from evidenced applied influence.

Verification: `app/src/project-overview-graph-rendered_test.ts` renders the real library in a disposable Electron/Vite fixture, exercising expansion/collapse, nested lane layout, selected details, keyboard activation, zoom/fit controls and pane panning. Vue Flow requires a browser DOM; the former SSR-only handwritten-SVG assertion was replaced by this genuine renderer check.


### Dashboard viewport update (October 2026)

The overview canvas now fills the remaining workbench space. Search and a native
category selector (with topic counts) float above it; the edge legend and context
caveats are available under Evidence. Inferred group interpretations remain
visible when filtering. Node details are dismissible overlays, with evidence
expanded on demand. Board filters remain separate.

Roots are ordered by latest recorded branch activity, newest left, with stable
unknown-date fallback. Opening starts at readable zoom 1 near the newest roots;
data refresh and expansion preserve the viewport. Filtering returns to recent
matching roots without shrinking below readable zoom. Back to recent resets to
zoom 1; Fit all topics is an explicit optional action in Evidence, not the default.


### 用户纠正：讨论方向、取舍与成果，而非执行分工（2026-10）

来源：用户以语音功能为例，明确要求保留曾讨论但后来搁置／放弃的微信输入法或第三方输入法方向；成果描述应更抽象，说明做了什么和状态。无人类参与取舍的 subagent 协助不应成为可见 child；每项成果可用简短自由 Markdown 说明 why、what、how。

本轮将主动整理的输出改为面向人的语义话题与卡片：讨论方向、重要取舍、成果和未决事项，而不是照搬 session 委派树。运行记录继续保留为来源证据，不构成默认展示层级。卡片状态必须引用本次提供的证据；执行结束不等于完成，没有后续活动也不等于放弃。自由 Markdown 用于解释目的、结果与实现方式，展示时进行安全处理。

此节修订上文“主动整理只读根笔记、32,000 字符且不读对话”的输入边界：整理现在通过 SessionManager 有界读取来源会话自身的物理片段，在 JSONL 和 SQLite 中均可读取用户输入与相关助手讨论／报告，以便恢复最终摘要遗漏的方案取舍。最多 30 个根笔记、240 条证据、每会话 8 个自身片段／80 条文本／扫描 20,000 条记录，总输入上限 64,000 字符（不含固定提示）。跳过 fork、工具轨迹和不能可靠确认人类来源的旧记录；不追踪整个 subagent 分工过程作为可见话题。

语义结果连同证据和卡片状态来源保存在可向后读取的项目整理快照中；总览用它替代原始执行层级。旧快照不会自动重跑，需要用户明确点击“整理近期话题”。自动观察继续更新来源笔记，并可使快照标为过时，不新增周期性语义总结调用。

验证采用明确讨论并放弃第三方输入法、转而实现本地语音输入的合成对话，检查取舍保留、成果合并、subagent-only 节点不展示、状态证据校验及 Markdown 呈现；包含 JSONL／SQLite 历史读取和真实 Electron／Vue Flow 渲染。此验证不证明真实语音对话已经重新整理，也不证明窗口之外的讨论已覆盖；未执行运行时模型调用、历史批量回填或应用重启。

用户随后澄清：Agent 的重要决定、怎么做以及实质性的执行分工同样值得保留，目标是减少细节，不是只记录人类参与的选择。整理应保留影响方案或结果的模型取舍，明确标为模型决定；通常融入成果的 how，确有独立意义时才单独成卡。一般委派、核验、重试和局部修复不逐一展示，压缩为实现说明。此澄清优先于将无人类参与的模型决定一律排除的理解。


## Inferred abstract overview hierarchy (2026-10-11)

Implemented display contract: `result.hierarchy?: { id, title, purpose, parentId?, groupIndexes }[]`. Fresh manual organization supplies a hierarchy; older snapshots without it remain readable. Every existing concrete `result.groups` entry belongs to exactly one hierarchy node by index. Abstract nodes are display-only model interpretations, never user instructions, persisted work ownership, delegation, or causal assertions. Cards retain semantic dispositions, Markdown explanations, human/model/report source distinctions and state evidence.

Bounds: organization considers at most 30 selected topic sources; groups max 30, each with max 30 topic keys and 20 cards; hierarchy max 60 nodes and four aggregation levels. IDs and topic memberships are unique, parents exist, cycles are rejected. The renderer uses saved hierarchy ownership as the single grouping truth, including root filters. It does not derive new semantic categories from labels. Legacy snapshots can use existing saved inferred categories; otherwise records appear under an explicit unorganized entry. Records outside the bounded organization window remain accessible under that entry rather than leaking individually into the root row or disappearing.

The default graph shows a few saved abstract directions. Concrete topics and evidence cards are disclosed through nested, dashed 2D ownership regions; expanding one branch does not duplicate nodes or force unrelated branches open. Root recency follows descendant dates. Mixed or absent dispositions are presented as mixed/unknown, not silently completed. Initial zoom remains 1, with no automatic fit-all; expansion centers the selected parent above its region at readable zoom. Data refresh preserves the viewport. Existing records do not acquire a hierarchy automatically: manual organization remains the only model operation, and rendering makes no model call.

Verification includes logic tests and real Electron/Vite-rendered synthetic fixtures: 35 concrete legacy topics (30 organized into three directions plus five explicitly unorganized) and 35 semantic evidence cards under two abstract directions with a nested subgroup. These fixtures demonstrate UI behavior, not completeness of a live project's bounded history or confirmation of inferred user intent.
