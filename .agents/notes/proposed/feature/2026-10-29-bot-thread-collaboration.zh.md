# Agent Note: 基于 thread 总线的多 bot 群聊协作

Status: proposed

[English](2026-10-29-bot-thread-collaboration.md) | 中文

## 问题

Zhiliao 现有的三项能力都止于单个 Session，因此无论怎么组合，都搭不出「一个总览 bot 加每个项目一个项目经理 bot」的形态。

项目（`ctx.workspaceRegistry`）维护有名字、有序的目录，并把 Session 归组进去，但它不向模型暴露任何工具、提示词或事件。任务都是会话级的：`todo_write` 会整表替换创建它的那个 Session 的列表，`goal` 每个 Session 只有一个目标，plan mode 也只属于一个 Session。委派（`ctx.subagents`）是父到子，两个同级 agent 无法互相寻址，子 agent 的状态也只能通过父级发现。

产品需要的是：一组独立、长期存活的 agent Session，通过一个共享媒介互相通信，再加一份能比任何单个 Session 活得更久的任务记录。人对「聊天群」这个媒介已有直觉，所以群只承载消息与通知，项目级任务记录才是权威状态。把群记录当成状态，会让每个结论都变成检索问题，每次重启都变成回放问题。

## 提案

新增 `bot` 包组与 `bot` profile bundle。bot 是独立、持久的 Session，绑定一个角色和可选的一个项目。thread（由一个 IM 群或话题承载）是 bot 与人之间的消息总线。项目级任务域是权威状态。

### 包与职责

| 包 | 职责 | ctx key |
|---|---|---|
| `bot/thread` | thread、消息、每个 bot 的已读位点、mention 解析、轮次预算与冷却 | `ctx.threads` |
| `bot/supervisor` | bot 注册表、thread 到项目到参与者的绑定、唤醒裁决、bot Session 的创建与恢复、轮次排队 | `ctx.botSupervisor` |
| `bot/task` | 基于 `storage-domain` 的项目级任务记录，沿用 workspace 注册表的做法 | `ctx.botTasks` |
| `bot/channel` | 通道 seam：归一化入站 IM 事件，渲染出站消息 | `ctx.channels` |
| `bot/channel-lark` | 只依赖 seam 的 Lark 适配器 | — |
| `bot/tool-thread` | 模型工具 `thread_read` 与 `thread_post` | 注册到 `ctx.tools` |
| `bot/tool-task` | 模型工具 `task_create`、`task_update`、`task_list` | 注册到 `ctx.tools` |
| `bot/presets` | 主 bot 与 PM bot 的 persona 及工具集差异 | — |
| `bundle/bot-app` | 用 `dsh.bundle.patch` 把上述各行组装成 `bot` profile | — |

### thread 模型

`ThreadMessage` 包含 id、thread id、每个 thread 单调递增的 `seq`、发送者（`{ kind: 'bot' | 'human', id }`）、被提及的 bot id 列表、类型（`request`、`status`、`result` 或 `note`）、正文、可选的任务引用与创建时间。每个 bot 按 thread 保存已读位点，因此一轮只会收到该位点之后的消息。

mention 是定向转交。不带 mention 的帖子是广播，而 bot 发出的广播不会唤醒任何人。

### 路由与唤醒

每个 thread 通过 `ownerBotId` 恰好绑定一个群主 bot。supervisor 应用同一套规则：

- 带 mention 的消息唤醒每个被提及、且属于该 thread 参与者的 bot；提及非参与者会被丢弃。
- 不带 mention 的消息，只有在发送者是人时才唤醒群主。
- bot 发出的消息永远不会通过「无 mention 规则」唤醒任何人；bot 要转交工作必须 mention 目标。
- 每次唤醒消耗该 bot 在该 thread 的轮次预算，并遵守两轮之间的冷却。预算大小与冷却都是 `Config` 字段。
- 预算耗尽时把消息记为 deferred 且不发帖，避免刷屏。

由 supervisor 而不是提示词决定谁被唤醒；提示词里的规则无法执行，也无法断言。

### bot 会话

主 bot 覆盖所有项目，读取项目摘要，可向任意已绑定的 thread 发帖，但没有写任务的工具。PM bot 绑定一个项目，拥有任务写权限，并可派生子代理。worker 是普通子代理，因此只有「PM 到 worker」这一段是父子关系。

一期把项目与 thread 绑成一比一，且 PM bot 同时是群主。一项目多 thread、人类指派与定时巡检都后置。

### 项目任务域

`ProjectTask` 包含 id、项目 id、标题、描述、状态、执行者、thread 引用、创建者、可选结果，以及带版本号的更新时间。状态机为 `todo → doing → blocked → done | cancelled`。一期执行者永远是 agent bot。

记录像 workspace 记录一样存放在 `storage-domain`，因此能跨重启存活，并留在任何 Session 日志之外。一个投影会把每次状态变更作为 `status` 消息发到引用的 thread，不依赖模型主动汇报。

### 会话日志

新增两个 `SessionEventMap` 成员：`thread/message` 表示投递给某个 bot 的入站消息区间，`thread/post` 表示出站帖子。两者都是必需的，因为群内容会进入模型，Session 日志必须能重建它。新增成员会牵动 TypeScript 与 Python 两套 SDK 的期望输出，并需要持久化类型变更确认。

### 通道 seam

`ctx.channels` 把入站 IM 事件归一化为 `ThreadMessage`，并渲染出站帖子。一期只有 `channel-lark` 一个适配器。一个 IM 应用账号可呈现多个 bot 身份，因此新增一个 bot 只需一行绑定记录，而不是一个新的 IM 应用。入站事件按 IM 消息 id 去重，出站重试携带幂等键。

### 多租户与鉴权

bot 的可见范围是结构约束，不是提示词约束。每个 bot 只能读写其在 supervisor 绑定表中列出的 thread；`thread_read` 与 `thread_post` 在模型介入前就拒绝绑定集合之外的 thread。因此 bot A 不可能读到 bot B 的 thread——`ctx.threads` 的查询以调用者 bot 及其绑定的 thread 集合为作用域。

租户边界是 IM 应用账号（或其平台 tenant id）。不同租户的 thread、task 与 bot Session 存放在独立的 storage-domain 命名空间下，查询时绝不跨租户拼接。跨租户引用是数据错误，不是权限校验的问题。

IM 应用凭据（app id、app secret、webhook 验签密钥、access token）存放在 credentials 服务的加密存储中。channel 适配器不持有 master secret；它向 credentials 服务申请一个带作用域的短期租约，并在当前发送窗口内使用该租约。凭据轮换由 credentials 服务负责，适配器每轮重新读取当前租约。

入站发送者身份取自平台验证后的 IM 身份（channel 适配器验签之后），模型或客户端无法设置。出站帖子使用该 bot 绑定的 IM 身份，该身份在 supervisor 注册时固化。

### 流式回投

channel seam 的出站渲染器订阅该 bot Session 的事件流，把 assistant 消息增量与工具结果增量映射到目标 IM 平台的发送原语。

支持消息编辑的平台（飞书、Slack、Discord）上，一轮 assistant 输出累积到一条 IM 消息，按节流间隔更新，轮次结束时定稿。不支持编辑的平台（QQ、微信、早期 Telegram bot API）上，该轮退化为多条分片消息。分片策略是一组 `Config` 字段：最大分片大小、最小发送间隔、是否合并连续的纯文本分片。

所有出站动作共享每个 bot 每个 thread 的一个节流器，与轮次预算独立。节流参数是 `Config` 字段。

重试与幂等复用 channel seam 已有的出站重试 + 幂等键机制，不另起一套重试语义。流式分片的幂等键是 bot turn id 加分片序号；最终消息的幂等键是 bot turn id。失败重试只重放失败的分片，不重放整轮。

工具调用与工具结果的中间状态是否回投到 IM 是一个 `Config` 选项；默认只回投最终 assistant 文本与显式的 `thread_post` 调用。

## 参考实现对照

以下判断提炼自本机 Grok Bot 0.78.1 的实测架构。每条只陈述 Grok Bot 的做法，目的是推导出它对本提案的含义；Grok Bot 不是依赖项。

**控制面与数据面分离。** Grok Bot 的控制面只负责换取凭据（租约），所有业务流量走单一数据面网关，凭据不随每次业务请求反复出示。对本提案而言，获取 IM 应用凭据（换 token）与使用凭据（发消息）在 channel seam 内是两个步骤。适配器不持有业务侧权限，只持有从租约换来的短期 token。

**租约式权限。** Grok Bot 一次性换取一组带作用域、带端口的 token（gateway、exec、vnc 各一），而非一个全局管理员凭据。对本提案而言，`ctx.botSupervisor` 派发轮次时颁发一个带作用域、带生命周期的授权，覆盖该轮可读写的 thread 集合与可调用的工具子集。bot Session 不持有全量通道凭据；授权在轮次结束时过期，下一轮重新颁发。

**耐久执行与存活分离。** Grok Bot 的协调器、daemon 与 signer 是独立进程；UI 崩溃不影响执行，daemon 带有 supervisor 与租约耐久文件，可跨重启恢复。对本提案而言，bot Session 的存活不绑定任何客户端连接。入站消息先落 thread 存储再做唤醒裁决；唤醒失败可从已落盘消息重放。supervisor 的绑定表与已读位点持久化，重启后恢复。

**长连接参数属于部署配置。** Grok Bot 把连接超时、stall 判定、退避倍数与健康探测间隔作为一等参数。对本提案而言，channel 适配器的连接超时、stall 判定、退避倍数、健康探测间隔、出站节流间隔与分片大小全部是 `Config` 字段，绝不写成 `DEFAULT_*` 常量。

**风控显式归因而非绕过。** Grok Bot 命中风控时结算成结构化错误类型并退避上报，不做特征串识别与破解尝试。对本提案而言，通道被平台限流或封禁时，适配器产出一个结构化错误状态，携带平台错误码、归因与建议退避时长。该错误交还人工或 supervisor 冷却，不重试到被封。错误记入 thread，不进入模型提示词。

**事件总线按域分发。** Grok Bot 用一个 SSE 端点按 channel 分发多类事件，而非每类事件一个连接。对本提案而言，thread 事件（message、post、status）与 Session 事件（assistant 增量、tool）的分发关系一次说清：channel seam 的出站侧订阅该 bot 的 Session 事件流并按事件类型路由到渲染器，入站侧把 IM 事件归一化为 `ThreadMessage` 后投递到 `ctx.threads`；两条总线在 bot 轮次边界汇合。

## 备选方案

**全部用子代理委派。** PM bot 可以把每个任务当成一个子代理，除此之外不暴露任何东西。它被否掉的原因是子代理只对父级可见，主 bot 要汇总项目工作只能遍历每棵树，而任务状态会随父 Session 消失。

**任务落在外部系统。** Lark 任务或 GitHub Issues 能让群外的人看到工作。一期否掉它的原因是：模型面会先依赖外部权限、时延和一个 MCP server，而协作模型本身还没建立。通道 seam 为以后把它作为镜像留了口子。

**每群一个共享 Session，由模型选择发言者。** 这是 AutoGen `GroupChatManager` 的做法，适合自由协作。这里否掉它，是因为所有 bot 会共享一个上下文和一份 Session 日志，PM bot 的项目记忆会被无关 thread 稀释，而「谁下一个发言」的权威会落在提示词里，而不是可执行的策略里。

**每个 thread 一个专门的群主 bot。** 把接待与路由和项目工作拆开会让转交更清晰。一期否掉它，是因为它让 bot 数量和绑定翻倍，而 PM bot 本来就持有群主所需的那份项目上下文。

**把群记录当成任务状态。** 这样可以完全省掉存储域。否掉的原因是状态只能从散文里推断，重启要回放无界的记录，而且两个 bot 可能对同一个 thread 有互相矛盾的读法。

## 验收标准

- 人在已绑定的 thread 里不带 mention 发一条消息，只有 PM bot 跑一轮，且它的 Session 日志记录该消息。
- 人在项目 thread 里 mention 主 bot，只有主 bot 跑。
- bot 发一条不带 mention 的消息，没有任何 Session 跑轮次。
- 某 bot 的轮次预算耗尽后，消息仍留在 thread 中并记为 deferred，不启动轮次。
- `task_create` 后再执行 `task_update`，会在该 thread 自动产生一条 `status` 帖子，无需模型主动要求公告。
- 重启 `bot` profile 后，每个 bot Session 与已读位点都能恢复，因此没有消息被重复投递或被跳过。
- 单元测试覆盖唤醒裁决、预算耗尽、冷却与位点推进。
- 真实组合测试用 test-only 的 `cordis.yml` 加一个假通道适配器启动，断言 thread、任务记录与 Session 日志三者一致。
- 快照钉住 PM bot 从请求到建任务再到回帖的转录，以及主 bot 的项目摘要。

## 风险

- **循环压力。** 两个 bot 可能不断互相回答。一期只有「bot 消息不走无 mention 规则」、轮次预算和冷却三道防线；若不够，二期需要显式的转交同意步骤。
- **IM 成为单点故障。** 通道故障会拖住所有 bot。一期选择显式失败，并以幂等键重试出站帖子，而不是掩盖故障。
- **Session 增长。** 每个 bot 一个持久 Session 会无界增长。上下文压缩可用，但尚未在长期运行的 bot Session 上验证；主 bot 的摘要路径以后可能需要自己的投影。
- **命名冲突。** 这里的「任务」指项目工作项，与 task-surface 提案里结构化 UI 的 `show_task_surface` 工具无关。包与工具沿用 `task` 名称，文档必须说明这一区别。
- **明确后置。** 一项目多 thread、人类执行者、自动巡检与多 worker 并发都不在一期范围内，因此一个项目同时跑两条工作流的情况目前无法表达。

## 相关

- [Workspace 子系统](../../../../docs/subsystems/workspace.zh.md)——`bot/task` 复用的持久项目注册表与 `storage-domain` 做法。
- [Subagent 子系统](../../../../docs/subsystems/subagent.zh.md)——worker 会话使用的父子委派契约。
- [Task Surface 提案](2026-08-04-task-surface.zh.md)——本仓中「任务」的另一层结构化 UI 含义。

## 变更记录

本次修订新增三节——「多租户与鉴权」、「流式回投」与「参考实现对照」，并把参考实现的判断融入通道 seam 设计。对照来源为本机 Grok Bot 0.78.1 的实测架构。未撤回任何已有的验收标准或风险项。
