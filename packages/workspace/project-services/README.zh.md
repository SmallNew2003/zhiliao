---
description: "供 Host 提供方、工具和图形客户端使用的统一项目服务 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services

[English](README.md) | 中文

## 概述

使用此包可以为人工调用方和智能体提供统一的项目服务 API，同时保留各自独立的权限。使用方可请求清单、独立日志分页、控制操作和实时快照。运行时实现和具体提供方是必要前提；本包不启动进程或容器。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将 `ProjectServiceRuntime` 实现为 `projectServices` 服务，再通过 Cordis effect 注册 `ProjectServiceProvider`。客户端不需要 Host 服务类时，可从 `/types` 入口导入 JSON 记录。[本地运行时](../project-services-local/README.zh.md)提供本地实现。

受信调用方授权已解析的项目、工作树、精确目标修订、原生命令或 Docker 身份。运行时在审批后重新验证策略和目标；即使准备是异步的，请求原本携带的修订也始终有效约束目标。返回的项目、工作树、服务、定义、分组、操作和提供方状态均经过读取授权。

提供方准备没有生命周期副作用，并提供非空的精确目标集合，包括新启动的预留身份。运行时在发布前同时预留这些 id 与定义/组别名。`validate` 检查已批准的身份和修订；`execute` 接收归 Host 所有的信号。可信原生适配器在变更前解析 `ServiceNativeLaunch`，并返回绑定到 `ServiceNativeLifetime` 的 `ServiceNativeProcess`；直接进程结果和受管范围完全停稳是独立事实。`nativeLaunch.targetId` 在所有现有目标之外标识预留的新范围，两种身份都会被预留并检查碰撞。提供方特定的重启预检属于准备阶段。

新定义的原生准备阶段收到 `pendingDefinition`，提供方可据此将启动的实例关联到持久 id。仅在授权后才持久化。`ServiceItem.definitionId` 将托管实例关联到该定义。定义 id、资源 id 和操作 id 均为不透明的品牌字符串。提供方快照可为仍拥有的托管项包含绑定项目的 `capturedCheckouts`；缺失工作树允许读取和停止，但不能启动或重启。过期行带有 `stale`，不能作为变更依据。不可读取的控制状态同时省略 `operation` 和 `pending`。

<a id="implementation"></a>
## 实现

<details>
<summary>Host 所有权和持久化</summary>

[源代码声明](src/types.ts)负责定义请求、快照、提供方观察和受信回调。线上记录不包含可执行权限。抽象服务独立于 GUI 和工具使用方，定义生命周期和读取要求。

此 API 不添加 Session 事件。将结果暴露给模型的使用方，必须通过既有工具执行路径记录结果。带有提供方前缀的目标 id 用于区分原生实例和容器资源。

不发布运行时不变量伴随模块：此服务定义不拥有可独立变化的观察状态。

</details>

<a id="model-experience"></a>
## 模型体验

### 项目服务 API

#### 模型可见内容

没有直接可见内容。`ctx.projectServices` 不贡献工具、提示词或 Session 事件；模型可见结果由使用方负责。

#### Token 影响

直接 Token 成本为零。工具使用方仅承担其暴露结果的成本。

#### KV Cache 影响

不直接修改请求前缀，也不使缓存失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此包不提供提供方、传输验证、UI 或模型工具。使用方必须构造受信权限并验证 JSON 请求。提供方必须遵守取消信号并等待托管进程范围终止；直接子进程退出并不意味着整个范围已静止。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包只提供定义而非提供方：共享的服务定义、品牌化标识、请求与视图契约，以及消费方共用的公开投影。其契约经由提供方与消费方包覆盖，例如 `pnpm exec vitest run packages/workspace/project-services-local`。

</details>
