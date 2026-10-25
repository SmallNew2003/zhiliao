---
description: "本地项目服务清单、持久启动定义、目标授权和独立日志读取器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services-local

[English](README.md) | 中文

## 概述

使用此包可以聚合本地 Git 工作树、保存服务启动定义，并通过统一的读取授权清单查看和控制服务。关联工作树共享 Git 公共目录；独立克隆和嵌套仓库仍是不同项目。提供方负责实际的原生进程或容器操作。本包需要本地文件系统访问、Git、子进程执行和存储域。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将 `project-services-local` 与 `subprocess`、`storageDomain` 一起加载。各提供方通过 Cordis effect 注册。Host 提供受信的 `ServiceAccess` 回调；JSON 请求不能提供调用方权限。定义在 Host 重启后保留，但不会自动启动。

配置默认值为：发现间隔 2,000 ms、最大新鲜度 10,000 ms、分页上限 200 项、保留输出 1,048,576 字节、日志响应上限 16,384 字节、终止宽限 5,000 ms、操作等待 30,000 ms、扫描期限 10,000 ms、扫描输出上限 1,048,576 字节，以及保留 200 条操作与请求记录。所有值都是正整数 Config 字段。提供方通过自身经过验证的配置限制其保留或终止的资源。

相同调用方、项目和请求 id 的控制请求共享一个操作。对同一键使用不同输入会被拒绝。完成的键仅在保留期间具有幂等性；达到容量时可淘汰最早结束的记录。现有目标操作在异步准备和审批期间始终绑定请求携带的修订。发布前预留已解析的实例 id、请求的定义或分组别名，以及新定义名称。目标集合重叠时串行执行，但外部操作方不受这些锁约束。

日志读取方各自拥有游标。`RetainedServiceLog` 保留 UTF-8 尾部，报告丢失字节，并将 JSON 元数据计入请求的字节上限。无法容纳元数据和一个字符的过小上限会被拒绝。提供方扫描过期或失败时保留最近观察到的行，标记 `stale: true` 并清空操作。每个保留行仍经过当前读取策略过滤，过期观察不能授权变更。

在 macOS 上加载可选的 `@deepseek-ai/dsh-project-services-local/native` 提供方，即可观察 TCP 监听器并运行受管命令。外部记录按规范化工作目录关联，不提供生命周期操作或捕获输出。TCP 端口不能证明存在 HTTP 或 HTTPS URL。结构化 `lsof` 字段和有界的 `ps` 创建时间观察会排除扫描期间发生变化的进程；扫描失败时，运行时保留显式标记为陈旧的清单。并发读取方仅共享当前归 Host 所有的原始扫描，各自独立取消。完成的观察不被缓存；工作目录关联、受管状态和读取权限逐读取方组装。

原生提供方配置使用显式 `shellPath`（`/bin/bash`）、`retainedOutputBytes`（1,048,576）、`terminationGraceMs`（5,000）、`scanTimeoutMs`（10,000）、`scanMaxBytes`（1,048,576）、`processInspectionMax`（200）、`captureIntervalMs`（25）和 `historyMaxInstances`（200）。数值字段均为正整数。历史上限淘汰最早停止的实例及其日志，同时保留所有活动范围；旧身份绝不指向替代实例。已淘汰实例的读取会报不可用。

人类启动准备会解析配置的本地 shell 和命令可执行文件。Agent 调用方使用原生入口导出的 `createShellServiceExecution(initiatingContext, ctx.nativeProjectServices.lifetime, request)`，传入当前沙箱策略和临时环境。工厂要求声明 POSIX 命令语法，捕获实际 shell 已准备的隔离，并请求保留至范围退出的输出；提供方要求 subprocess realm 相同且 Host 生命周期信号完全一致，因此归 Session 所有的适配器会被拒绝。重启审批同时列明现有实例和预留的替代实例身份。停止前会预检启动与终止两个阶段；每次启动都有独立 id 和保留输出。发布后的发起方取消与发起作用域释放不会终止范围；提供方/Host 释放会中止待处理启动、回滚延迟取得的句柄、终止受管范围并等待完全停稳。

原生生命周期状态依据所拥有的范围，而非直接 shell 的结果。直接退出码/信号事实独立可见。可选的提供方成员观察只在当前存在肯定所有权证据时去除重复的受管监听器记录；不支持观察时保留外部记录。macOS 成员关系和创建时间标签属于观察结果，受 subprocess 提供方记录的进程组限制约束；它们绝不授权向外部数字 PID 发信号。

<a id="implementation"></a>
## 实现

<details>
<summary>Host 所有权和持久化</summary>

解析器通过 Workspace 路径助手规范化现有目录，并执行有界的 Git 请求。项目身份由执行身份与规范 Git 公共目录组合而成；非 Git 目录则使用规范 cwd。Git 项目的项目路径指向公共目录，工作树路径指向工作目录。实时 Git 解析器排除已登记但缺失的工作树。提供方可随其仍拥有的匹配托管项提供 `capturedCheckouts`；运行时将这些工作树标记为 `availability: missing`，保留读取、日志和停止能力，并拒绝启动与重启。其他工作树显式标记为 `availability: present`。捕获事实必须保留原项目和工作树身份，不能用于授权新启动。`project_services` 存储域使用版本 1，在持久化时验证定义和关联。

已发布操作使用由 Host 拥有的单一控制器。Host 销毁会取消待执行工作、等待操作结束并关闭存储；提供方负责服务进程范围的清理，且必须保留 Docker 资源。即使读取器处于暂停状态，取消订阅也会移除两个取消监听器及提供方订阅。重新连接从新基线开始。修订对项目、调用方和经过读取授权的内容计算哈希，因此其他项目或读取方不会使未变化页面的游标失效。运行时在刷新权限和应用最终读取过滤之前冻结候选事实；被隐藏的控制操作既不暴露记录，也不暴露 `pending` 状态。

不发布运行时不变量伴随模块：定义和关联直接从存储表读取，没有第二份缓存；操作结果描述请求，而不是独立镜像提供方的实时状态。

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

- 运行时仅解析本地路径，并需要 Git 区分仓库。具体原生和 Docker 提供方通过独立贡献加载。清单分页限制服务项；定义、分组和保留操作属于独立集合。Host 本地锁无法防止外部进程或 Docker 变更。完整 Loader、工具快照和产品验收由提供方与使用方组合负责。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

使用 `pnpm exec vitest run packages/workspace/project-services-local` 运行运行时测试；它在 fake subprocess 上覆盖项目解析、原生发现与生命周期、日志留存与读取授权过滤，无需 Host 进程。

</details>
