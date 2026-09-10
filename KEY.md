> **Product ideas / historical design notes:** the desired behaviors below are
> not a shipped-feature checklist. In particular, proposed alignment/graph UI
> and automatic verification workflows need separate implementation evidence.
> See [current architecture and status](docs/architecture.md) and the
> [documentation index](docs/README.md).

## 主 Agent 改进

> 我们需要通过改进system prompt和tools来改变主agent的行为

- 主agent需要学grill me skill with the docs by default，目标是和用户做alignment
  - 做alignment可以调用特殊的tool来ask user questions，工具要求agent提供一个问题列表，用户回答后，agent再做alignment
  - 主agent做alignment的时候需要注意用户的任务目标的动机，并且记录下来
  - 问题如果是关于领域问题，必须有一个选项是用户让渡权力给agent自己决策，比如agent问了一个代码决策问题，但是用户不是代码export，需要有一个fallback选项让agent自己做决策，这样agent也对用户水平有个alignment。代码是一个例子，可以是其他任意领域
    - 简单的例子就是 1是agent recommend直觉的选项，2-3是alternative，4是fallback表示用户对此不熟悉，需要agent best effort做决策，5是用户free input text
  - （ui 改动）和用户做的alignment会persist 成document，这类doc在fs种有特定格式，我们需要把这些document渲染成graph式ui，最终展示给用户（ui work，not agent work）
  - （ui 改动）如果主agent创建了子agent group（project），那么我们在ui中需要有graph式的ui显示子agent的状态（避免用户问进度）
- 少自己做，多handoff给子agent做，不过给子agent前主agent必须对任务有一个明确的理解，明确的deliverable，明确的验收标准，明确的时间要求，明确的资源要求，明确的约束条件 

### Project & Subagent how to loop

主agent生成另一个verify agent，专门couple with任务subagent，任务子agent做完后，verify agent会检查任务子agent的结果是否符合主agent的预期，如果不符合，verify agent会要求任务子agent重新执行，直到结果符合预期。

- 子agent的划分，可以分若干个干活的子agent work on 同一个目标，子agent划分逻辑是focus area和context
- 多个干活的子agent可以共享同一个verify agent
