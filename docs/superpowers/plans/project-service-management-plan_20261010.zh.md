# 项目服务管理实施计划

[English](project-service-management-plan_20261010.md) | 中文

> **执行要求：** 使用 subagent-driven-development 按顺序执行任务，每个实现任务后独立复查。

**目标：** 通过同一界面和三个 agent（智能体）工具管理跨 Git worktree 的原生及 Docker/Compose 项目服务。

**架构：** Cordis 运行时解析项目归属、保存原生启动定义和容器关联、拥有原生服务，并聚合由 effect 管理的提供方贡献。受信消费者提供读取和实际操作授权。Docker 保留容器生命周期所有权。

**技术栈：** TypeScript ESM、Cordis、storage-domain、subprocess/shell、Typert Remote、React slot/store、Zod、Vitest 及已有会话/浏览器测试设施。

**规格：** [已复查设计](../specs/project-service-management-design_20261010_02.zh.md)。

## 全局约束

- 首版支持本地 macOS 原生发现及固定的本地 Docker context。
- 没有绑定身份的信号机制时，外部原生进程只读；检查 PID 后再 kill 不满足要求。
- 发现间隔 2 秒；最大时效 10 秒；每页最多 200 个服务；每个原生实例保留 1 MiB 输出；agent 日志结果上限 16 KiB；终止宽限期 5 秒；操作等待 30 秒。所有随部署变化的值均为经过验证的 Config 字段。
- 人类与 agent 权限分别处理。所有返回数据经过读取授权。修改授权绑定不可变的实际目标，并在审批后重新验证修订号、取消、沙箱及审批策略。
- 原生重启在停止前预检双阶段。Docker 分组冻结精确容器 id 并报告部分/未尝试结果；本地锁不能排除外部操作者。
- Session dispose（资源释放）保持已发布服务存活。Host dispose 等待原生范围终止并保留全部 Docker 容器。不自动启动、恢复、唤醒或持续注入提示词。
- 三个工具为 service_list、service_logs 和 service_control，使用规范 JSON 结果、已有工具日志及可回放展示元数据。
- 使用严格类型、品牌化 id、effect 管理的注册、本地化界面文案、双语文档及源码测试，不修改 agent loop（智能体循环）。
- 每位实现者仅修改任务范围，运行有意义的针对性测试、记录红绿证据、提交并撰写报告，不再派遣子代理。

## 共享 API

任务 1 拥有下列名称。后续任务导入源码声明，不复制线协议模型。请求与快照兼容 JSON；ServiceAccess 和提供方句柄留在 Host 进程内。

```text
ProjectServiceRuntime extends Service; Context.projectServices
list(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): Promise<ServiceInventory>
logs(access: ServiceAccess, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage>
control(access: ServiceAccess, request: ServiceControlRequest, signal: AbortSignal): Promise<ServiceControlResult>
follow(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): AsyncIterable<ServiceFeedFrame>
registerProvider(provider: ProjectServiceProvider): () => void
ServiceAccess: actorId, kind (human | agent), cwd, executionIdentity, authorize, canRead, revalidate, optional native execution adapter
ResolvedServiceOperation: action, project, checkout, exact targets/revisions, optional resolved native launch, optional Docker facts
ServiceControlRequest: start with definition {name, checkoutId, command}, or start/stop/restart with targetId; requestId and expectedRevision for existing targets
ServiceInventory: project, checkouts, items, definitions, groups, providers, operations, revision, optional nextCursor
ServiceLogPage: chunks with source identity, nextCursor, truncated, gap, optional unavailable reason
ServiceFeedFrame: baseline(snapshot) | updated(snapshot)
ProjectServiceProvider: id, kind, inspect, prepare, logs, optional subscribe; prepared operations expose immutable description, validate, execute
```

首版提供方贡献可返回刷新后的快照，不要求字段级补丁。订阅保留有序修订号和重连后的新基线。原生及 Docker 目标 id 不透明且包含提供方身份。

### Task 1: 共享运行时与项目解析

**文件：** 创建 packages/workspace/project-services/{package.json,tsconfig.json,src/index.ts,src/types.ts,README.md,README.zh.md}；packages/workspace/project-services-local/{package.json,tsconfig.json,src/index.ts,src/projects.ts,src/storage.ts,src/operations.ts,src/logs.ts,tests/projects.spec.ts,tests/runtime.spec.ts,README.md,README.zh.md}。更新这些包所需的源码别名及 Host 项目引用。

**接口：** 消费 Cordis、storage-domain、subprocess 及已有 Workspace 路径约定。产出共享 API、持久定义/关联 schema、项目/worktree 解析、读取过滤快照、操作串行/去重及独立日志保留。提供方启动在任务 2 接入。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
it('groups an external worktree with its common repository but excludes an independent clone', async () => {
  const inventory = await runtime.list(accessFor(linkedWorktree), {}, signal)
  expect(inventory.checkouts.map(item => item.path).sort()).toEqual([mainRoot, linkedWorktree].sort())
  expect(inventory.checkouts.some(item => item.path === cloneRoot)).toBe(false)
})
```

使用真实临时 Git 仓库及仓库根之外的 worktree，补充非 Git、嵌套仓库、符号链接和路径缺失。使用可控提供方 promise 验证授权拒绝、审批后修订变化、重复请求 id、并发操作、读取过滤的操作结果、订阅 dispose 及独立/截断日志读取。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm exec vitest run packages/workspace/project-services-local/tests
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
const prepared = await provider.prepare(target, request, access, signal)
await access.authorize(prepared.description, signal)
await access.revalidate(signal)
await prepared.validate(signal)
return prepared.execute(operationSignal)
```

通过明确且有上限的子进程请求实现规范 Git 公共目录解析和 worktree 枚举，仅保留已验证本地路径。通过存储域而非会话事件保存定义。提供方贡献由 effect 管理。每目标锁内按给出的次序执行，使用一个操作控制器并在发布后改用 Host 所有信号。快照/日志/状态输出前执行读取授权，扫描失败明确标记过期。撰写包文档及适当的独立不变量观察，或说明不存在独立观察。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。

### Task 2: 原生进程发现与托管执行

**文件：** 创建 packages/workspace/project-services-local/src/{native.ts,native-discovery.ts,native-execution.ts}；tests/{native.spec.ts,native-discovery.spec.ts,native-lifecycle.spec.ts}。扩展本地运行时和文档，使用公开 subprocess/shell API，不导入 subprocess-local 私有实现。

**接口：** 消费任务 1 的项目范围、提供方预检、日志及授权。产出原生提供方、人类/agent 执行适配器接口、TCP 监听观察，以及跨 Session dispose 存活的托管句柄。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
it('leaves the running instance alive when restart launch authorization is denied', async () => {
  const started = await startOwnedFixture()
  await expect(restartWithDeniedLaunch(started)).rejects.toThrow()
  expect(await fixtureResponds(started)).toBe(true)
})
```

使用绑定回环端口 0 并明确发送就绪消息的 Node fixture（测试前置数据）。覆盖过期进程创建身份、缺少可信外部停止能力、工作目录关联、扫描失败、启动回滚、后代范围清理、并发停止/重启、Session dispose 与 Host 关闭，以及外层调用取消后仍存活的捕获。测试必须等待所拥有进程完全静止。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm exec vitest run packages/workspace/project-services-local/tests
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
const spec = await execution.resolve(definition, signal)
const description = describeRestart(currentInstance, spec)
await access.authorize(description, signal)
await access.revalidate(signal)
await validateCurrentInstance(currentInstance, signal)
await currentInstance.stop()
return execution.start(spec, hostSignal)
```

使用 macOS 结构化 lsof 记录及有上限的进程检查观察监听/cwd。明确外部原生停止不可用，不实现数字 PID 发信号。停止/启动前解析完整原生启动，输出只捕获一次并供独立消费者读取。人类执行通过 subprocess 使用明确本地 shell；agent 适配器提供解析后的沙箱 shell 启动，并匹配随 Host 存活的 subprocess 身份。拒绝不匹配或归 Session 所有的执行提供方。保留提供方退出事实，如实报告终止失败。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。

### Task 3: Docker 与 Compose 提供方

**文件：** 创建 packages/workspace/project-services-docker/{package.json,tsconfig.json,src/index.ts,src/transport.ts,src/membership.ts,src/operations.ts,src/logs.ts,tests/membership.spec.ts,tests/operations.spec.ts,tests/provider.spec.ts,README.md,README.zh.md}，添加别名/引用及必要依赖锁文件变化。

**接口：** 消费任务 1 的精确提供方 API 和项目范围。产出可选且由 effect 管理的 Docker 贡献，含固定本地 context/守护进程、容器原始状态/健康、经验证归属、Compose 分组、有上限日志及已有容器操作。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
it('does not act on a replacement container after the first group member succeeds', async () => {
  const result = await operateFrozenGroupWithReplacement()
  expect(result.members.map(item => item.status)).toEqual(['completed', 'unattempted'])
  expect(await replacementContainerState()).toBe('running')
})
```

使用录制的结构化 Docker 响应及可控传输，覆盖守护进程/context 替换、仅标签的模糊归属、冲突挂载、两个 worktree 的 Compose 重名、一次性容器排除、共享容器、无健康检查、仅暴露端口、不可读日志、游标缺口及预检/中途成员漂移。真实集成测试仅创建唯一标签的一次性资源，并只清理捕获的 id。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm exec vitest run packages/workspace/project-services-docker/tests
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
const ids = group.members.map(member => member.containerId).sort()
await authorizeEveryFrozenTarget(ids)
await rejectChangedPreflightMembership(ids)
for (const id of ids) {
  await verifyOriginalDaemonAndContainer(id)
  await operateExistingContainer(id)
}
```

使用已安装 Docker CLI（命令行界面），通过 subprocess 传入明确 argv、固定 --context 及结构化 JSON/format 输出，不手写 Docker 线协议，不接受 agent 任意 CLI 片段。限制 inspect/list/events/log 获取，投影排除环境变量值，在事件缺口和取消后核对状态，并在每次修改前核验守护进程身份。错误返回精确部分/未尝试结果。启动/停止/重启不调用 compose up/down、build、exec、rm 或卷/网络删除。提供方 dispose 仅关闭观察。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。

### Task 4: Agent 工具与已认证 Remote API

**文件：** 创建 packages/workspace/tool-project-services/{package.json,tsconfig.json,src/index.ts,src/access.ts,tests/tools.spec.ts,tests/access.spec.ts,README.md,README.zh.md}；packages/api/project-services-controller/{package.json,tsconfig.host.json,tsconfig.client.json,tsconfig.json,src/index.ts,src/types.ts,src/client/index.ts,src/client/service.ts,tests/controller.host.spec.ts,tests/service.client.spec.ts,README.md,README.zh.md}。

**接口：** 消费共享 API 和两类提供方。产出 service_list/service_logs/service_control、纯 Host 展示转换器及持久元数据、已认证 remote.projectServices list/logs/control/follow，以及框架无关的客户端可观察服务。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
it('rejects a grant when approval policy changes while the answer is pending', async () => {
  const operation = beginServiceControl()
  await approvalAsked
  setApprovalPolicy('never')
  answerApproval('allowed-once')
  await expect(operation).rejects.toThrow()
  expect(await targetState()).toBe('running')
})
```

测试原生与 Docker 读取授权、包含全部目标的分组审计、缺失/拒绝授权、沙箱/审批变化、执行身份不匹配、其他项目、有上限日志、规范 schema、无实时查询的回放展示及基线/重连订阅。实现自动读取授权前核对当前策略语义；已知项目不授予 Docker 或跨 Session 日志权限。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm exec vitest run packages/workspace/tool-project-services/tests packages/api/project-services-controller/tests
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
const operationPolicy = currentPolicy(exec.agent.session)
const outcome = await ctx.approval.request({agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: describeAllTargets(operation), signal})
if (outcome !== 'allowed-once') throw new Error('Service operation not authorized')
assertPolicyUnchanged(operationPolicy, currentPolicy(exec.agent.session))
signal.throwIfAborted()
```

仅在受信消费者内创建 ServiceAccess。控制器通过 workspaceRegistry 解析 WorkspaceId；工具从当前 Session 获取 cwd。每个 agent 修改同时经过默认工具准入和实际目标审批。列表、日志、操作结果及订阅均明确过滤读取权限。审批理由包含所有具体动作/目标，组过大时拒绝而非截断。使用当前作用域 shell 与沙箱策略，但核验进程提供方随 Host 存活。只注册简短工具用法，快照仅经正常工具结果进入模型。生成 Typert 声明，并使用分离的 Host/Client 配置。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。

### Task 5: 项目服务面板与应用组合

**文件：** 创建 packages/client/ui-project-services/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts,src/client/index.ts,src/client/ServicesPanel.tsx,src/client/locales.ts,src/client/styles.module.css,tests/panel.client.spec.tsx,README.md,README.zh.md}。扩展 ui-workspace 行操作 slot/约定、包文档及测试；更新 bundle/web-app 组合/依赖和 Host/Client 聚合引用。

**接口：** 消费 remote.projectServices 及客户端可观察 API。产出 Workspace 服务入口、根主面板、目录/提供方筛选、定义创建、原生/容器/Compose 行、日志、获准操作、分组进度和本地化工具卡片。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
it('keeps native services visible when Docker becomes unavailable', async () => {
  renderServicesPanel(nativeAndDockerSnapshot)
  publishSnapshot(dockerUnavailableSnapshot)
  expect(screen.getByText('frontend')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Docker unavailable')
})
```

测试无打开 Session 时的 Workspace 入口、原生启动校验、Docker 单体/分组操作、能力缺失、过期行、共享分组、无健康检查展示、日志截断、独立读取、导航取消和重连。界面测试使用本地化属性/字典，断言无障碍行为而非类名。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm exec vitest run packages/client/ui-project-services/tests packages/client/ui-workspace/tests
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
ctx.slots.inject('main', () => ctx.slots.register('main', {key: 'project-services', component: ServicesPanel, inject: panelDependencies}))
ctx.layout.selectPanel('project-services')
```

使用已有 slot、store 和 locale 模式，组件通过框架属性接收数据/回调，并通过框架 hook 订阅。添加可扩展 Workspace 操作 slot，不让 ui-workspace 导入此功能。复用基础控件和语义 CSS token。界面不把运行等同健康，不把容器私有地址当作 localhost 打开，并以明确能力原因保留只读行。在受支持本地 profile 中组合本地运行时、可选 Docker、控制器/客户端及界面；agent 组合须能使用工具，同时不意外改变 headless 默认组合。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。

### Task 6: 录制与真实流程验收

**文件：** 使用已有设施添加基于 profile 的无密钥服务场景及拥有者本地的浏览器/Docker 集成 fixture；更新相关子系统页、README、生成目录、必要持久类型确认，以及一份具有双语记录的持久架构 Agent Note。

**接口：** 消费完整组合功能。产出界面与 agent 共享状态、本地进程和 Docker 使用相同项目范围、关闭保留容器生命周期，以及回放历史结果不查询实时资源的证据。

- [ ] **步骤 1：添加失败的行为回归。** 通过真实生产消费者建立下列行为；示例中的 fixture 辅助函数归本任务测试文件所有。

```text
expect(agentListedIds).toContain(guiStartedInstanceId)
expect(await panelStatus(agentRestartedInstanceId)).toBe('running')
expect(await dockerContainerExists(containerId)).toBe(true)
```

使用主目录及外部 worktree、原生回环服务、独立容器及多副本 Compose fixture。测试列表/日志/启动/重启/停止、拒绝与过期操作、Docker 不可用界面，以及 Host 关闭后容器存活。将工具/PTC 输出和浏览器预期放在正确所属测试设施下。绝不把已有用户服务用作 fixture。

- [ ] **步骤 2：观察回归因缺少目标行为而失败。**

```sh
pnpm run test:gui
```

- [ ] **步骤 3：按下列操作关系实现任务。**

```text
await launchSupportedDshProfile(testOverlay)
await verifyGuiAndAgentOperations()
await verifyDockerFixtures()
await recordRealFlowGif()
await disposeOwnedFixturesAndAwaitQuiescence()
```

先运行针对性测试，再运行生成源码检查/类型检查、相关构建 smoke、定向无密钥快照及浏览器回放。浏览器自动化使用仓库目录选择器覆盖配置。通过 record-browser-gif 记录真实服务/模型流程 GIF，明确报告缺少的真实模型或 Docker 证据。manifest（元数据清单）/目录稳定后运行 doc-sync（文档同步门禁）及相关 lint/hygiene。已有 Comet 缺配对/断链属于基线问题，不混入此功能。交付前进行一次完整独立分支复查并修复；未经授权不推送、合并或发布。

- [ ] **步骤 4：重跑针对性命令，检查实际结果并验证修改后的包约定。** 在任务报告中记录精确证据及平台跳过情况。

- [ ] **步骤 5：提交任务范围差异并请求独立任务复查。** 提交主题使用英文任务名称；进入下一任务前修复重要问题。
