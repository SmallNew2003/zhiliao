---
description: "提供具有经验证守护进程身份和 Compose 分组的 Docker 与 Compose 项目服务提供方贡献。"
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services-docker

[English](README.md) | 中文

## 概述

使用此包将 Docker 和 Compose 容器检查、Compose 服务分组、有上限的日志获取以及生命周期管理贡献到共享的项目服务运行时中。容器通过经验证的 Compose 项目工作目录、配置路径或绑定挂载源关联到 Git 工作树。它需要本地安装 Docker CLI，并连接到固定的本地 Docker 上下文。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将 `project-services-docker` 与 `project-services` 和 `subprocess` 一起加载。提供方在 `[Service.init]()` 中通过 Cordis 效应注册。资源释放时注销贡献并清理轮询定时器，但保留所有正在运行的 Docker 容器及其数据卷。

配置默认值为：上下文 `""`（默认上下文）、命令 `"docker"`、终止宽限期 5,000 毫秒、扫描间隔 2,000 毫秒、新鲜度上限 10,000 毫秒、单次派发截止时间 10,000 毫秒、单流捕获上限 10,485,760 字节、inspect 批大小 100 个容器 ID 以及日志尾部上限 1,000 行。所有数值字段均为正整数。终止宽限期大于单次派发截止时间时加载即报错：`docker stop -t` 的宽限期发生在一次 CLI 调用内部，截止时间更短时它永远无法完成。

检查操作查询守护进程身份并列出容器。如果未安装 Docker 或无法连接守护进程，提供方将返回带有底层错误原因的不可用或过期状态，绝不伪装为空的成功。与项目工作树检出或明确关联匹配的容器将出现在服务清单中；一次性容器和无关外部容器将被排除。Compose 副本将分组在其共享的 Compose 服务名称下。

生命周期操作支持对已有容器和冻结的 Compose 分组执行 `start`、`stop` 和 `restart`。Compose 分组操作冻结精确的成员容器 ID，并在修改任何目标前验证成员关系未发生漂移。如果较早的成员成功而后续成员失败，其余成员将被报告为未尝试，且不会对替换容器执行操作。

<a id="implementation"></a>
## 实现

<details>
<summary>传输、成员关系与操作</summary>

提供方使用结构化的 `DockerTransport`，通过固定的 `--context` 参数和结构化 JSON 输出包装 CLI 调用。默认子进程执行器让每次调用都从固定工作目录运行，按配置的捕获上限约束每个输出流，并把单次派发截止时间与调用方取消信号一并作为超时生效；子进程被信号杀死或输出流溢出时该次调用失败，而不是伪装成一次成功的空退出。容器 ID 按有界批次传给 `docker inspect`，避免繁忙主机耗尽参数上限导致整扫失败。

成员关系解析使用 `com.docker.compose.project.working_dir`、`com.docker.compose.project.config_files` 和绑定挂载源将容器映射到检出，选择最匹配的具体检出路径。端口映射仅提取已发布的宿主端口，排除仅暴露的容器端口。Compose 分组 ID 由检出 ID、Compose 项目与服务名组成，因此同一仓库的两个工作树运行相同的 Compose 项目与服务时会产生不同的分组 ID 与不同的控制目标。新鲜度缓存按项目键控：新鲜度窗口内每个项目只会读到自己的观测结果，绝不会拿到另一个项目的容器表面。

操作在准备、验证和执行时检查守护进程身份。如果守护进程重启或更改身份，操作将被拒绝。

未发布运行时不变量配套模块：Docker 容器生命周期由 Docker Engine 拥有，此包不会在本地维护容器状态的持久副本。

</details>

<a id="model-experience"></a>
## 模型体验

### 项目服务 Docker 提供方

#### 模型可见内容

无直接内容。提供方不提供工具、提示词或会话事件；使用 `ctx.projectServices` 的工具与控制器拥有模型可见输出。

#### Token 影响

零直接 token。

#### KV Cache 影响

无直接请求前缀更改或缓存失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 仅连接到配置的本地 Docker 上下文。故意省略远程上下文、容器构建/重建、镜像拉取、数据卷删除和网络删除。无法排除外部在 harness 之外执行的 Docker 操作。
- 容器日志按读取方游标使用 `--since`，并丢弃游标时刻及更早的行，因此与游标时间戳完全相同的行会被视为已投递。两个容器流按流拼接而非按时间交错，且 `--tail` 截断可能在无可检测信号的情况下丢弃更早的行，因此日志页不会报告 gap。被截断的页从最后一条已投递的行继续。
- 提供方不产出 `capturedCheckouts`：已保存的关联不携带检出路径，因此受管 Docker 项所在的检出目录消失时无法重建为检出事实，运行时的缺失检出准入保留给原生提供方。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

使用 `pnpm exec vitest run packages/workspace/project-services-docker` 运行提供方测试；它在 mock 执行器上驱动守护进程身份、容器发现、Compose 分组操作与 wire 校验 schema，无需 Docker 守护进程。

</details>
