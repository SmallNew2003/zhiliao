# Assistants and tasks

English | [中文](assistant.zh.md)

## Summary

Assistants keep a persistent conversation for the Host or one registered Workspace and delegate work to separate task Sessions. The [assistant service](../../packages/assistant/task/README.md) owns durable assistant and task records, status reconciliation, cancellation, and the visibility feed. The [assistant tool](../../packages/assistant/tool-task/README.md) allows only registered assistant Sessions to create and read their tasks.

## Table of Contents

- [Identity and views](#identity-and-views)
- [Requests and failures](#requests-and-failures)
- [Session visibility](#session-visibility)

<a id="identity-and-views"></a>
## Identity and views

The [assistant types](../../packages/assistant/task/src/types.ts) define `AssistantId` and `AssistantTaskId` as distinct branded identities. `AssistantKind` selects global or project ownership. `AssistantView` exposes the current conversation Session and retired Session ids; `AssistantTaskView` exposes task title, state, execution Session identity, availability, optional final `resultSummary`, and optional `AssistantTaskFailure`.

`AssistantTaskStatus` distinguishes `created`, `running`, `waiting-approval`, `waiting-answer`, `cancelling`, `done`, `failed`, and `cancelled`. Task identity can exist before its execution Session becomes available. Storage owns these relationships independently of Session headers; ordinary Session origin and recovery rules remain authoritative.

<a id="requests-and-failures"></a>
## Requests and failures

`AssistantsEnsureRequest` creates or reuses an assistant in an explicit scope. `AssistantsListRequest` and `AssistantTasksListRequest` filter durable views; task listing also accepts bounded pagination. `AssistantTaskRequest` and `AssistantTasksCancelRequest` identify one task for an authorized detail read or cancellation. Host-only `AssistantTaskCreateRequest` identifies the calling assistant Session, prompt, optional target Workspace, idempotency key, and cancellation signal; `AssistantTaskCreateValue` returns reserved task and Session ids.

`AssistantTaskErrorCode` classifies rejected scope, unavailable Workspace or preset, invalid input, quota, storage, Session creation, and delivery failures. `AssistantTaskErrorDetails` retains task and Session identities when creation has progressed; `AssistantTaskError` carries that classification and actionable detail. Callers can distinguish a task that was never created from a durable failed task.

<a id="session-visibility"></a>
## Session visibility

`AssistantVisibilityRequest` reserves the visibility request vocabulary. `AssistantVisibilityValue` contains visible separated Session ids plus `AssistantConversationEntry` and `AssistantExecutionEntry` ownership records. Retired assistant conversations stay separated from ordinary Workspace navigation. The [client](../../packages/client/ui-assistant/README.md) registers this feed with the Workspace hidden-Session source; explicit Session opening remains available. Remote lists and visibility require each entity's Session grant and its Workspace grant where applicable; hiding a Session does not grant access.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Read one task after authorizing the execution Session and target Workspace.
 * @param request - Task identity.
 * @returns Current task details.
 */
@Remote('task') task(request: AssistantTaskRequest): AssistantTaskView

/**
 * List the calling assistant's own tasks.
 * @param caller - Calling conversation.
 * @param page - Task-list page bounds.
 * @returns Current task details in newest-first order.
 */
listForAssistant(caller: SessionId, page: Pick<AssistantTasksListRequest, 'limit' | 'offset'>): AssistantTaskView[]

/**
 * Read a task belonging to the calling assistant.
 * @param caller - Calling conversation.
 * @param id - Task identity supplied by the model.
 * @returns Current task details.
 */
taskForAssistant(caller: SessionId, id: AssistantTaskId): AssistantTaskView

/**
 * Stop admission and join the execution Agent and its descendants.
 * @param request - Task identity.
 * @returns The task after quiescence, or its unchanged terminal state.
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

Types: [SessionId](core.md)

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
