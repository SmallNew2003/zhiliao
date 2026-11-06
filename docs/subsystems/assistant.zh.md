# 助理与任务

[English](assistant.md) | 中文

## 概述

助理为 Host 或某个已注册 Workspace 保留持久对话，并将工作委派到独立任务 Session。[助理服务](../../packages/assistant/task/README.zh.md)负责持久助理与任务记录、状态协调、取消和可见性数据流。[助理工具](../../packages/assistant/tool-task/README.zh.md)仅从助理 Session 创建任务。

## 目录

- [标识与视图](#identity-and-views)
- [请求与失败](#requests-and-failures)
- [Session 可见性](#session-visibility)

<a id="identity-and-views"></a>
## 标识与视图

[助理类型](../../packages/assistant/task/src/types.ts)将 `AssistantId` 与 `AssistantTaskId` 定义为不同的品牌标识。`AssistantKind` 选择全局或项目归属。`AssistantView` 提供当前对话 Session 与已退役 Session ID；`AssistantTaskView` 提供任务标题、状态、执行 Session 标识、可用性及可选的 `AssistantTaskFailure`。

`AssistantTaskStatus` 区分 `created`、`running`、`waiting-approval`、`waiting-answer`、`done`、`failed` 与 `cancelled`。任务标识可以先于执行 Session 的可用状态存在。存储独立于 Session 头部管理这些关系，普通 Session 的来源与恢复规则仍然有效。

<a id="requests-and-failures"></a>
## 请求与失败

`AssistantsEnsureRequest` 在显式范围中创建或复用助理。`AssistantsListRequest` 与 `AssistantTasksListRequest` 过滤持久视图，任务列表还接受有界分页。`AssistantTasksCancelRequest` 指定一个任务。仅限 Host 的 `AssistantTaskCreateRequest` 指定调用助理 Session、提示词、可选目标 Workspace、幂等键与取消信号；`AssistantTaskCreateValue` 返回预留的任务与 Session ID。

`AssistantTaskErrorCode` 对范围拒绝、Workspace 或 preset 不可用、输入无效、配额、存储、Session 创建及投递失败分类。`AssistantTaskErrorDetails` 在创建已有进展时保留任务与 Session 标识；`AssistantTaskError` 携带分类与可操作详情。调用者可区分未曾创建的任务与已持久化的失败任务。

<a id="session-visibility"></a>
## Session 可见性

`AssistantVisibilityRequest` 保留可见性请求类型。`AssistantVisibilityValue` 包含可见的分离 Session ID，以及 `AssistantConversationEntry` 和 `AssistantExecutionEntry` 归属记录。已退役的助理对话仍与普通 Workspace 导航分离。[客户端](../../packages/client/ui-assistant/README.zh.md)将该数据流注册到 Workspace 隐藏 Session 来源，显式打开 Session 仍然可用。Remote 列表与可见性需要每个实体的 Session 授权，适用时还需要 Workspace 授权；隐藏 Session 不会授予访问权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxassistanttasks--assistanttaskservice"></a>

### `ctx.assistantTasks` — `AssistantTaskService`

Host-wide assistant records and assistant tasks.

Assistant conversations are ordinary Sessions; task execution Sessions are ordinary root Sessions created through the same Session controller the Web client uses. This service owns only the durable mapping, status derivation, and separation identity; it never writes task markers into Session headers.

```ts cordis-catalog
/**
 * Create or reuse one assistant in the requested scope.
 * @param request - Global or project scope; a project must name a registered Workspace.
 * @returns The current assistant record.
 */
@Remote('ensureAssistant') async ensureAssistant(request: AssistantsEnsureRequest): Promise<AssistantView>

/**
 * List assistant records.
 * @param request - Optional scope filter.
 * @returns Matching assistants, global first.
 */
@Remote('assistants') listAssistants(request?: AssistantsListRequest): AssistantView[]

/**
 * List assistant tasks newest first.
 * @param request - Optional assistant, project, and page bounds.
 * @returns One bounded page of task views.
 */
@Remote('tasks') listTasks(request?: AssistantTasksListRequest): AssistantTaskView[]

/**
 * Cancel one assistant task.
 * @param request - Task identity.
 * @returns The updated task view, or the unchanged terminal task.
 */
@Remote('cancelTask') async cancelTask(request: AssistantTasksCancelRequest): Promise<AssistantTaskView>

/**
 * Read the Session ids the assistant surface must separate from user tasks.
 * @returns Current and retired assistant Sessions, every task execution
 *   Session, and each one's owning assistant or task.
 */
@Remote('visibility') visibility(): AssistantVisibilityValue

/**
 * Create one assistant task and deliver its first prompt through the Session controller.
 * @param request - Caller assistant Session, prompt, optional title and target project.
 * @returns The task and its reserved execution Session.
 */
async createTask(request: AssistantTaskCreateRequest): Promise<AssistantTaskCreateValue>

/**
 * Check whether the Session is a registered assistant conversation.
 * @param sessionId - candidate conversation Session.
 * @returns whether the assistant domain owns this conversation.
 */
isAssistant(sessionId: SessionId): boolean

/**
 * Read one task view by id, if present.
 * @param id - task identity.
 * @returns current task view, or undefined when absent.
 */
getTask(id: AssistantTaskId): AssistantTaskView | undefined
```

Types: [SessionId](core.zh.md)

Source: [`packages/assistant/task/src/index.ts`](../../packages/assistant/task/src/index.ts)

<a id="assistant-events"></a>

### `assistant/*` events

<a id="assistantchanged--emit"></a>

#### `assistant/changed` — emit

One assistant record was created, replaced, or retired.

```ts cordis-catalog
/** One assistant record was created, replaced, or retired.
 * @mode emit
 */
'assistant/changed'(): void
```

Source: [`packages/assistant/task/src/types.ts`](../../packages/assistant/task/src/types.ts)

<a id="assistant-task-events"></a>

### `assistant-task/*` events

<a id="assistant-taskchanged--emit"></a>

#### `assistant-task/changed` — emit

One assistant task changed; clients refresh the named task or catalog.

```ts cordis-catalog
/** One assistant task changed; clients refresh the named task or catalog.
 * @param taskId - task whose persisted view changed.
 * @mode emit
 */
'assistant-task/changed'(taskId: AssistantTaskId): void
```

Source: [`packages/assistant/task/src/types.ts`](../../packages/assistant/task/src/types.ts)
<!-- END GENERATED cordis-surface -->
