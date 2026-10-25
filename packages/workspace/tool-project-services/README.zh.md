---
description: "模型端项目服务工具：service_list、service_logs 与 service_control。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-project-services

[English](README.md) | 中文

## 概述

`dsh-tool-project-services` 提供三个 Agent 工具（`service_list`、`service_logs` 与 `service_control`），用于发现与管理当前项目关联 Git worktree 下的原生开发进程与 Docker/Compose 容器。单次日志读取上限 16 KiB，并明确报告输出是被截断还是已被丢弃。`service_control` 的每个动作都属于变更，由一道 fail-closed 的授权步骤把关，只有审批放行才能通过。

## 目录

- [三个工具](#the-three-tools)
- [配置项](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

<a id="the-three-tools"></a>

## 三个工具

- `service_list(checkout_id?, kind?, state?, cursor?, limit?)` — 跨关联工作树发现运行中与已停止的服务，给出每个目标的状态、端口、归属与 `revision`。
- `service_logs(target_id, cursor?, max_bytes?)` — 读取某个服务目标最多 16 KiB 的留存输出。`truncated` 表示本次读取停在字节上限，`gap` 表示运行时已丢弃部分输出，`unavailable` 表示该目标不保留输出。
- `service_control(action, target_id?, expected_revision?, definition?)` — 启动、停止或重启一个服务，每个动作都属于变更。针对既有目标的调用需带上 `service_list` 报告的 `expected_revision`；修订号不再匹配时本次调用失败，而不是操作一个调用方已经看不到的服务。

<a id="configuration"></a>
## 配置项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `defaultMaxLogBytes` | `16384` | 单次日志读取默认字节上限 |
| `maxLogBytesCap` | `16384` | 单次日志读取绝对上限 |
| `defaultPageLimit` | `50` | 服务列表默认分页大小 |
| `maxPageLimit` | `200` | 服务列表最大分页大小 |
| `approvalPolicy` | `'ask'` | 变更类操作立场：`'ask'` 把每次变更交给主机审批服务（无应答方时 fail-closed）；`'never'` 不问任何人，直接拒绝所有变更类操作 |

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型可见内容

插件激活期间会注册一段固定的 `tool:project-services` 指引区段（顺序值 1650）。

##### 项目服务指引

```markdown
Use `service_list` to see the native processes and Docker containers this project and its Git worktrees run, with each target's state, ports, and `revision`. Use `service_logs` to read one target's retained output: at most 16 KiB per call, so follow `nextCursor` for more; `truncated` marks a call that stopped at the cap, `gap` marks output the runtime already discarded, and `unavailable` names a target that keeps no output. Use `service_control` to start, stop, or restart one service; every action mutates and is gated by one approval decision. Pass `expected_revision` from the `service_list` row you act on: a revision that no longer matches fails the call instead of touching a service you no longer see. Prefer these tools over shelling out to `ps`, `lsof`, or `docker ps`; do not use them for a one-off command or a process that is not a project service.
```

#### Token 影响

插件激活期间每次请求都携带这段固定区段；没有任何配置字段改动其文本。

#### KV Cache 影响

只要插件与指引文本不变，前缀就保持稳定。插件激活或释放可能使从该区段起的复用失效。

### 工具 schema

#### 模型可见内容

模型看到生成的 [`service_list`、`service_logs` 与 `service_control` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-project-services)。列表过滤与调用方的分页参数留在 schema 中，主机侧分页上限与提供方游标值则无法在其中表达。`service_control` 把 `action` 固定为 `start`、`stop` 或 `restart`，并把结果 `state` 固定为 `running`、`succeeded`、`failed` 或 `unknown`。

#### Token 影响

工具可见期间每次请求都发送这三个固定 schema；按 agent 作用域实施的工具限制可以移除其中一个。

#### KV Cache 影响

只要工具可见性与定义不变，前缀就保持稳定；某项限制或插件释放可能使从第一个变化的定义起的复用失效。

### 工具结果

#### 模型可见内容

每次调用输出一个格式化文本块。列表会打印项目及其 checkout，随后每个服务一行（含名称、类型、状态、归属、端口与修订号），并视情况输出 `(no matching services)`、`Provider warnings: <id>: <state> (<reason>)` 与 `Next cursor: <cursor>` 行。日志读取按分片逐行打印，并报告 `truncated`、`gap` 与 `unavailable` 标志。控制调用按结果逐条打印 `Service <action> (<operationId-or-requestId>): <target>: <state>…`；运行时接受了调用但不报告状态时，打印 `submitted, but the current read policy denies reading its operation status`。

#### Token 影响

结果随数据而变，并留在工具历史中直至压缩；一页至多 `maxPageLimit` 项，一次日志读取至多 `maxLogBytesCap` 字节。

#### KV Cache 影响

结果文本只追加，跟在可复用的请求前缀之后，不会使此前的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明这三个工具够不到或决定不了的内容。它们是当前包约束，不是任务清单。

- **过滤发生在取页之后** —— `service_list` 先取一页（至多 `maxPageLimit` 项），再按 `checkout_id`、`kind` 与 `state` 过滤，因此带过滤的调用返回的匹配项可能少于 `limit`；后续页的匹配只能靠 `nextCursor` 到达。
- **单次日志读取有上限** —— `maxLogBytesCap`（默认 16 KiB）是调用方无法抬高的天花板，更长的输出需要游标分页，运行时已丢弃的输出则取不到。
- **变更类调用需要主机审批接缝与调用方 Agent** —— 在 `approvalPolicy: 'ask'` 下，未挂载审批服务的组合、或没有调用方 Agent 的执行，都会在任何生命周期副作用之前拒绝所有变更类操作；只有 `'allowed-once'` 会放行。`approvalPolicy: 'never'` 则不问任何人，直接全部拒绝。
- **原生启动需要原生提供方与 Host 域的 shell** —— `service_control` 从可选的 native provider 构造原生启动适配器，因此未挂载该提供方的组合会把原生 start/restart 留给运行时明确的 `Service provider unavailable` 拒绝，而 Docker 控制与所有读取照常可用。启动出来的进程域归 Host 所有、比发起会话活得更久，因此它采用 shell 执行器的部署策略，而不是会话级的沙箱提权。
- **提供方不可达只降级列表，不让调用失败** —— Docker 守护进程不可达时，容器面以非 `ready` 且带原因的提供方状态到达，渲染为 `Provider warnings:` 行，容器服务带 `[stale]` 标签；原生服务仍然可见，没有调用因提供方而失败。
- **每次控制只作用于一个目标** —— 工具只变更单个目标或启动单个定义；Docker/Compose 分组随列表一起给出成员 id，整组停止需要逐成员各发一次控制调用。
- **读取未被收窄** —— `canRead` 把每个观测到的资源都授给 Agent 访问，因此读取过滤交给运行时及其提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

用 `pnpm exec vitest run packages/workspace/tool-project-services` 跑工具用例；该用例经模拟的 `ProjectServiceRuntime` 驱动全部三个工具，并为 agent 执行路径加载真实的 native provider，不需要 key，也不需要 Docker 守护进程。

</details>

**运行时不变式：** 不发布运行时不变式伴生入口。这些工具读取与变更的状态都由项目服务运行时持有，本包不持有任何可被独立观察拆分的所属关系。
