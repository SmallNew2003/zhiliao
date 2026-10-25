# Agent Note: 人机共享的持久任务域

Status: proposed

[English](2026-10-10-persistent-human-agent-task-domain.md) | 中文

## 问题

`tool-todo` 已经给 agent 一份可见的任务列表，但它的设计前提是「单个 agent 会话对自己当前工作的规划」，而不是一份人要长期管理的事务清单：列表只属于创建它的那一个会话，每次 `todo_write` 整体替换整份列表，条目没有稳定身份，`TodoItem` 只有 `content` 与三个状态。整表替换对会话内规划是正确取舍——重写计划比逐条 diff 更省 token，也更少出错——但它无法回答「这条上周我提的、agent 说做完了的事，结果是什么」。

产品因此缺少一个跨会话、跨项目、人与 agent 共同持有的任务域。缺的不是另一个列表工具，而是持久记录、稳定身份、局部更新和权限边界。

同时存在三种真实需求，它们的差别不在数据形状，而在**谁是权威**、**谁消费**：个人事务清单（人记、agent 帮忙推进）、项目任务板（人与 agent 共同维护）、agent 派单台（人设置、agent 执行）。把它们做成三套实体会让三份数据、三份 UI 和三套权限规则各自漂移；只做其中一种则另外两种无处安放。

## 提案

新增持久任务域，由 [`storage-domain`](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md) 承载：每条任务是一个独立的 KV 记录，拥有稳定 id，模型与 UI 通过同一份数据读写。任务域与 `tool-todo` 并存且互不引用，各自服务自己的场景。

### 三种需求，两个 scope，一个属性

个人事务与项目任务板的差别是**归属**，派单台的差别是**执行者**。归属用判别联合表达，执行者是一个可空属性：

```text
TaskScope = { kind: 'inbox' }                      // personal affairs, no project
           | { kind: 'project', workspaceId }      // belongs to a workspace project

TaskAssignee = null                                 // unclaimed
             | { kind: 'session', sessionId }      // dispatched to a session's agent
```

「agent 派单台」由此得到：scope 为 `inbox` 或 `project`，assignee 指向具体会话。它不需要第三种 scope，因为它的数据形状与前两者完全相同——差别只在谁看这个列表、谁有权改。

workspace 项目被移除时，挂在它上面的任务**不删除**，scope 退化为 `{ kind: 'inbox' }` 并保留原 `workspaceId` 于 `detachedFrom` 供追溯。这与 workspace 自身「移除项目不删会话与文件夹」的约定一致。

### 记录形状

```ts
type TaskStatus = 'open' | 'doing' | 'blocked' | 'done' | 'dropped'

type TaskBlockReason = { code: string, message: string }   // lower-kebab-case routing code plus human-readable explanation
```

```text
TaskRecord = {
  id: TaskId                       // branded uuid, stable across restarts
  title: string                    // one imperative line, the primary UI label
  note?: string                    // longer description; where the agent records the outcome
  status: TaskStatus
  blockedReason?: TaskBlockReason // present exactly while status === 'blocked'
  scope: TaskScope
  assignee?: TaskAssignee
  due?: string                     // ISO-8601 absolute instant; reminders are schedule's job
  origin: 'human' | 'agent'        // who created it — the basis of every permission rule
  createdAt: string
  updatedAt: string
  updatedBy: 'human' | 'agent' | 'system'
  detachedFrom?: WorkspaceId       // former owner after project removal, trace only
}
```

`status` 采用五态而非三态，多出的 `blocked` 与 `dropped` 各有明确用途：`blocked` 表示「因问题停下」，与 [goal 的 `blocked`](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md) 语义一致并复用其路由码惯例；`dropped` 是唯一的废弃通道，让「删除」永远是可逆的。

`origin` 与 `updatedBy` 不是审计装饰，而是权限判定的唯一依据。删掉它们，权限规则就退化成「模型想改什么就改什么」。

### 权限边界

agent 对任务的写入能力按「谁建的」与「往哪个方向改」两个维度决定：

| 操作 | `origin: 'human'` 的任务 | `origin: 'agent'` 的任务 |
|---|---|---|
| 创建 | 允许 | 允许 |
| 改 `title` / `note` / `due` | 允许 | 允许 |
| `open` → `doing` / `doing` → `done` | 允许 | 允许 |
| 置 `blocked`（须带 code 与说明） | 允许 | 允许 |
| `done` → `open`（回退） | **拒绝** | 允许 |
| `dropped` | **拒绝** | 允许 |
| 物理删除 | 从不 | 从不 |

三条负向保证值得单独说明。

**agent 不能把任务退回未完成。** 模型判断一项工作没做完时，这条任务已经消耗了人的注意力，此时退回等于让同一条目反复占用清单，模型也会倾向于把没把握的事标成完成以外的状态来规避。agent 想撤销已完成的任务，只能新建一条并在 `note` 里写明「撤销 XXX，因为 YYY」，由人合并。

**agent 不能丢弃人建的任务。** `dropped` 是一条终态但保留记录，人可以在 UI 里恢复。

**没有物理删除。** 任何删除都是 `dropped`，记录与 `updatedBy` 留在存储里。

**agent 完成一项任务必须写 `note`。** `task_complete` 要求非空说明，它既是给 agent 自己的收尾检查（说不清做了什么，通常意味着没做完），也是这条记录在三个月后唯一还有价值的部分。这条约束是工具层的准入，不是提示词里的建议。

### 工具面

给模型的工具是 op 式的，与 `todo_write` 的整表替换相对：

- `task_create(title, scope?, due?, note?)` → 返回 `TaskId`
- `task_update(id, { status?, note?, title?, due? })` → 受上表权限约束
- `task_complete(id, note)` → `note` 非空
- `task_block(id, code, message)` / `task_unblock(id)`
- `task_list(filter?)` → 按 scope、assignee、status 筛选
- `task_drop(id, reason)`

不提供整表替换，也不提供「删除」。筛选在存储层完成并只返回 id 与 title 摘要，完整记录按需单条读取，避免把整份清单塞进上下文。

### 上下文成本

持久清单可能很大，因此**默认零注入**。会话开始时不把任务域放进提示词，只有两条例外：assignee 指向当前会话且状态不是 `done`/`dropped` 的任务标题清单（与 `todo_write` 在 agent loop 里的作用重合，但指向持久记录），以及 `due` 在近期窗口内的任务。其余一律由模型显式 `task_list` 拉取。

这条规则是刻意的：清单是无界的，而上下文是有界的。把「全部待办」当成常规注入，等于给每个会话开头加一份会不断增长的账单。

### 与 `tool-todo` 的分工

两者并存，互不引用，各自的数据与生命周期独立：

| | `tool-todo` | 任务域 |
|---|---|---|
| 归属 | 单个 agent 会话独占 | 跨会话，人机共享 |
| 更新 | 整表替换，last-write-wins | 单条 op，稳定 id |
| 身份 | 无，条目靠 `content` 识别 | 有，`TaskId` 跨重启稳定 |
| 生命周期 | 随会话日志，会话结束即止 | 长期存在 |
| 用途 | 本次工作怎么推进 | 这件事本身的状态 |

不存在自动同步。模型在会话里规划出的步骤不自动进入任务域；把一条规划项提升为持久任务是显式的 `task_create` 调用，需要判断它是否真的值得长期存在。反向也不做：任务域里的条目不会被塞进 agent 的会话内规划列表。

### 不驱动 agent loop

任务域**不触发任何自动执行**。`task_complete` 不开启轮次，assignee 指向某个会话也不唤醒该会话。任务域是一份被读写的记录，不是一个调度器。

「派单即执行」——即 assignee 为一个已关闭的会话时自动唤醒它开始工作——需要跨会话调度、并发写归属和失败重试语义，与 [goal 的 round driver](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md) 属于同一类问题。这份提案有意不触碰它；派单台在本提案里的含义是「人指定任务归属，agent 在自己被叫起来时看到它」，而不是「派单触发执行」。

### UI

新增 `ui-task` 侧栏面板，照 `ui-goal` / `ui-schedule` 的现成模式：静态注册、按项目目录分组、状态筛选。`storage-domain` 在每次写入持久化后发出 `domain/changed`，因此 agent 在会话里勾掉一项，面板自动同步，无需轮询。

面板必须暴露 `origin` 与 `updatedBy`——用户需要知道哪条是 agent 加的、哪条被 agent 动过。

## 考虑过的替代方案

**扩展 `tool-todo` 而非新建域。**不予采用。`tool-todo` 的三条设计——单会话独占、整表替换、条目无身份——都是会话内规划的正确取舍，不是待收敛的技术债。把持久任务塞进同一个包，需要推翻这三条契约，同时让两种语义（临时工作台与长期清单）在同一个工具描述里竞争模型的注意力。代价是既有快照与不变量配套插件全部重做，而收益仅是省下一个包名。

**做成独立应用，通过 MCP 接进 agent。**不予采用。这样会有两套 UI、两份数据、两个进程，以及一个必须双向同步的接缝：用户在独立应用里勾掉一项，agent 侧要感知；agent 写回一项，独立应用要实时看到。而宿主里已经具备所需的一切——`storage-domain` 提供跨重启持久化与变更事件，`workspace` 提供项目 scope 与生命周期约定，`ui-schedule` / `ui-goal` 提供侧栏面板的现成模式。独立应用会把这些积木全部弃用后重新实现一遍。

**用会话事件溯源持久化任务，像 `goal` 那样。**不予采用。`goal` 的持久化建立在「目标属于同一个会话」之上，所以 `goal/change` 进会话日志是自然的。任务跨会话存在——个人事务不属于任何特定会话——放进会话日志意味着一个任务的身份取决于它第一次被创建的那个会话，而 fork 与回放会把它复制成多个互不相干的副本。`storage-domain` 的按 id 读写与变更事件正是这个形状需要的。

**一条任务一个 JSON 大数组，而不是每任务一条记录。**不予采用。大数组只能整表读写，等于把 `todo_write` 的 last-write-wins 原样带进持久领域：人和 agent 各改一条时，后写的覆盖先写的，且无法按 id 定位、无法在 UI 里只更新一行。`storage-domain` 的 KV 分面按记录持久，正是为了这个形状。

**用三套独立实体承载三种需求。**不予采用。三份 schema 会各自漂移，第三种需求出现时无处归类，最终变成三套权限规则、三份 UI 和用户需要在三个地方找同一件事。scope + assignee 让三种需求共用一份记录，代价是 `assignee` 在个人场景下通常为空——这个代价明显更小。

## 验收标准

- 一条任务在 Host 重启后仍可按 `TaskId` 读到，`createdAt` / `updatedAt` / `origin` 未变。
- 人和 agent 在同一记录上交替修改，双方各自只影响自己授权的字段；agent 对 `origin: 'human'` 任务的 `done` → `open` 与 `dropped` 调用以明确原因失败，任务内容不变。
- `task_complete` 缺少 `note` 或传入空 `note` 时失败，且不写入任何状态。
- 没有任何路径可以物理删除一条任务记录；`dropped` 记录保留全部字段与 `updatedBy`，可在 UI 中恢复。
- 会话开始时提示词只包含 assignee 指向当前会话的未完成标题，以及近期 `due` 任务；`task_list` 之外的任务记录不出现在上下文中。
- `tool-todo` 的既有快照与行为不变；任务域的记录不出现在 `todo_write` 的列表里，`todo_write` 的条目也不出现在任务域里。
- workspace 项目被移除后，原挂载的任务仍可读，scope 退化为 `inbox`，`detachedFrom` 记录原 `workspaceId`。
- 任务域的写入不产生会话事件、不开启轮次、不唤醒任何会话；assignee 指向一个已关闭的会话时同样如此。
- `domain/changed` 使 UI 面板在 agent 侧写入后实时更新，无需刷新或轮询。
- 前缀快照表明：无论任务数量与状态如何变化，模型看到的任务工具定义保持稳定，只有调用参数变化。

## 风险

**上下文预算是这个设计最容易出错的地方。** 近期 `due` 窗口与 assignee 注入都是硬编码的启发式，一旦某天清单长到几千条，它们会成为每轮固定的开销。缓解办法是让这两个注入都可关闭，并接受关闭后 agent 需要显式 `task_list` 才能看到自己的任务。

**`blocked` 与 `done` 的判定权在模型手里。** 权限表只约束方向，不约束判断质量。模型可能把大量任务标成 `blocked` 来回避推进。`blocked` 必须带 code 与说明这一约束会让这种滥用在数据上可见，但可见不等于会被处理。

**任务域会吸引范围蔓延。** 一个能记 due、能分组、能标记来源的清单，很容易被要求加上子任务、依赖关系、标签、评论、优先级。每一项都让记录从「一件事的状态」滑向「一个项目管理系统」。第一版明确拒绝这些字段；一旦开始加，说明该重新评估是不是在造 issue tracker。

**与 `todo_write` 并存会让用户困惑。** 两份列表，一份随会话消失、一份长期存在，同一件事可能在两边都有痕迹。缓解靠命名与可见性：UI 里待办面板只显示任务域，`todo_write` 继续只在会话内呈现。做不到的话，这份提案应该被拒绝而不是继续演化。

**并发写入靠单条写入链而非版本号。** `storage-domain` 保证同一领域的写入串行执行、`update` 的变换不会交错，因此不需要乐观锁。但「仅当当前状态是 X 才允许改成 Y」这类检查只能在 `update` 的变换函数内读取当时的状态并自行拒绝，跨两次调用（如「读状态 → 决策 → 写结果」）的条件更新不受支持。当前权限规则都是单次调用内可判定的，若将来需要跨调用条件，必须先给领域加修订号。
