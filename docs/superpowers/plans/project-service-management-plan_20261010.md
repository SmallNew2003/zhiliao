# Project service management implementation plan

English | [中文](project-service-management-plan_20261010.zh.md)

> **For agentic workers:** Use subagent-driven-development to execute the tasks in order, with a task review after each implementation.

**Goal:** Manage native and Docker/Compose project services across Git worktrees from one GUI and three agent tools.

**Architecture:** A Cordis runtime resolves project membership, persists native launch definitions and container associations, owns native services, and merges effect-owned provider contributions. Trusted consumers supply read and resolved-operation authorization. Docker retains container lifetime ownership.

**Tech Stack:** TypeScript ESM, Cordis, storage-domain, subprocess/shell, Typert Remote, React slots/stores, Zod, Vitest, existing session/browser harnesses.

**Spec:** [Reviewed design](../specs/project-service-management-design_20261010_02.md).

## Global Constraints

- Local macOS native discovery and a pinned local Docker context are the initial supported execution environments.
- External native processes are read-only unless an identity-bound signaling mechanism exists; PID check-then-kill is insufficient.
- Discovery interval 2 seconds; freshness maximum 10 seconds; page maximum 200 services; native retained output 1 MiB per instance; agent log result 16 KiB; termination grace 5 seconds; operation wait 30 seconds. Every deployment-varying value is a validated Config field.
- Human and agent authority remain distinct. All returned data is read-authorized. Mutations authorize immutable resolved targets and revalidate revisions, cancellation, sandbox policy and approval policy after approval.
- Native restart preflights both phases before stopping. Docker groups freeze exact container ids and report partial/unattempted outcomes; local locks cannot exclude external actors.
- Session disposal keeps published services alive. Host disposal awaits native range termination and preserves all Docker containers. No automatic starts, recovery, wakeups or continuous prompt injection.
- The three tools are service_list, service_logs and service_control. They use canonical JSON results, existing tool logs and replayable presentation metadata.
- Use strict types, branded ids, effect-owned registrations, localized UI copy, bilingual documentation and source-plane tests. Leave the agent loop unchanged.
- Each implementer changes only its task scope, runs meaningful focused tests, records red/green evidence, commits, and writes its report. It must not dispatch subagents.

## Shared API

Task 1 owns these names. Later tasks import the source declarations instead of duplicating wire models. Requests and snapshots are JSON-compatible; ServiceAccess and provider handles stay within the Host process.

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

The first provider contribution may return refreshed snapshots rather than per-field patches. The feed retains ordered revisions and fresh baselines after reconnect. Native and Docker target ids are opaque and provider-qualified.

### Task 1: Shared runtime and project resolution

**Files:** Create packages/workspace/project-services/{package.json,tsconfig.json,src/index.ts,src/types.ts,README.md,README.zh.md}; packages/workspace/project-services-local/{package.json,tsconfig.json,src/index.ts,src/projects.ts,src/storage.ts,src/operations.ts,src/logs.ts,tests/projects.spec.ts,tests/runtime.spec.ts,README.md,README.zh.md}. Update source aliases and Host project references needed by these packages.

**Interfaces:** Consumes Cordis, storage-domain, subprocess and existing Workspace path conventions. Produces the Shared API, durable definition/association schemas, project/worktree resolution, read-filtered snapshots, operation serialization/deduplication and independent log retention. Provider-specific launches arrive in Task 2.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

```text
it('groups an external worktree with its common repository but excludes an independent clone', async () => {
  const inventory = await runtime.list(accessFor(linkedWorktree), {}, signal)
  expect(inventory.checkouts.map(item => item.path).sort()).toEqual([mainRoot, linkedWorktree].sort())
  expect(inventory.checkouts.some(item => item.path === cloneRoot)).toBe(false)
})
```

Use real temporary Git repositories and a worktree outside the repository root. Add non-Git/nested-repository/symlink/missing-path cases. Use controlled fake provider promises for authorization denial, post-approval revision changes, duplicate request ids, overlapping operations, read-filtered operation results, subscription disposal and independent/truncated log readers.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm exec vitest run packages/workspace/project-services-local/tests
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
const prepared = await provider.prepare(target, request, access, signal)
await access.authorize(prepared.description, signal)
await access.revalidate(signal)
await prepared.validate(signal)
return prepared.execute(operationSignal)
```

Implement canonical Git-common-directory resolution and worktree enumeration through explicit bounded subprocess requests, retaining only validated local paths. Persist definitions through a storage domain, not session events. Keep provider contributions effect-owned. Implement the listed operation ordering under per-target locks, with one operation controller and a Host-owned signal after publication. Require read authorization before snapshot/log/status emission and report stale scan failures explicitly. Write package docs and appropriate invariant observations, or document the absence of independent observations.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: shared runtime and project resolution` as the commit subject; fix important findings before the next task.

### Task 2: Native process discovery and managed execution

**Files:** Create packages/workspace/project-services-local/src/{native.ts,native-discovery.ts,native-execution.ts}; tests/{native.spec.ts,native-discovery.spec.ts,native-lifecycle.spec.ts}. Extend the local runtime and its docs; use public subprocess/shell APIs, never private subprocess-local imports.

**Interfaces:** Consumes Task 1 project scope, provider preparation, logs and authorization. Produces the native provider, human/agent execution adapter interface, observed TCP listeners and managed process handles that survive Session disposal.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

```text
it('leaves the running instance alive when restart launch authorization is denied', async () => {
  const started = await startOwnedFixture()
  await expect(restartWithDeniedLaunch(started)).rejects.toThrow()
  expect(await fixtureResponds(started)).toBe(true)
})
```

Use Node fixtures binding loopback port 0 and explicit readiness messages. Cover stale process creation identities, absence of trustworthy external stop capability, working-directory association, scan failure, launch rollback, child-range cleanup, concurrent stop/restart, Session disposal versus Host shutdown, and capture that survives outer-call cancellation. Tests must await owned process quiescence.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm exec vitest run packages/workspace/project-services-local/tests
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
const spec = await execution.resolve(definition, signal)
const description = describeRestart(currentInstance, spec)
await access.authorize(description, signal)
await access.revalidate(signal)
await validateCurrentInstance(currentInstance, signal)
await currentInstance.stop()
return execution.start(spec, hostSignal)
```

Use macOS structured lsof records and bounded process inspection for listener/cwd observations. Advertise external native stop unavailable; do not implement numeric-PID signaling. Resolve a complete native launch before stop/start and retain output once for independent consumers. Human execution uses an explicit local shell via subprocess; the agent adapter provides its resolved sandboxed shell launch while matching the Host-lived subprocess identity. Reject mismatched/Session-owned execution providers. Preserve provider exit facts and fail termination honestly.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: native process discovery and managed execution` as the commit subject; fix important findings before the next task.

### Task 3: Docker and Compose provider

**Files:** Create packages/workspace/project-services-docker/{package.json,tsconfig.json,src/index.ts,src/transport.ts,src/membership.ts,src/operations.ts,src/logs.ts,tests/membership.spec.ts,tests/operations.spec.ts,tests/provider.spec.ts,README.md,README.zh.md}; add aliases/references and any dependency lockfile changes.

**Interfaces:** Consumes the exact Task 1 provider API and project scope. Produces an optional effect-owned Docker contribution with pinned local context/daemon, native container states/health, verified membership, Compose groups, bounded logs and existing-container operations.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

```text
it('does not act on a replacement container after the first group member succeeds', async () => {
  const result = await operateFrozenGroupWithReplacement()
  expect(result.members.map(item => item.status)).toEqual(['completed', 'unattempted'])
  expect(await replacementContainerState()).toBe('running')
})
```

Use recorded structured Docker responses and a controlled transport for daemon/context replacement, label-only ambiguity, conflicting mounts, two worktrees with the same Compose name, one-off exclusion, shared containers, health absence, exposed-only ports, unreadable logs, cursor gaps, and preflight/midflight membership drift. A real integration test must create only uniquely labeled disposable resources and clean only captured ids.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm exec vitest run packages/workspace/project-services-docker/tests
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
const ids = group.members.map(member => member.containerId).sort()
await authorizeEveryFrozenTarget(ids)
await rejectChangedPreflightMembership(ids)
for (const id of ids) {
  await verifyOriginalDaemonAndContainer(id)
  await operateExistingContainer(id)
}
```

Use the installed Docker CLI with explicit argv, pinned --context and structured JSON/format output through subprocess; do not handwrite the Docker wire protocol. Never accept arbitrary CLI fragments from agents. Bound inspect/list/events/log acquisition, discard environment values from projections, reconcile after event gaps and cancellation, and verify daemon identity before each mutation. Operation errors return exact partial/unattempted outcomes. Start/stop/restart never invoke compose up/down, build, exec, rm or volume/network removal. Provider disposal closes observation only.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: docker and compose provider` as the commit subject; fix important findings before the next task.

### Task 4: Agent tools and authenticated Remote API

**Files:** Create packages/workspace/tool-project-services/{package.json,tsconfig.json,src/index.ts,src/access.ts,tests/tools.spec.ts,tests/access.spec.ts,README.md,README.zh.md}; packages/api/project-services-controller/{package.json,tsconfig.host.json,tsconfig.client.json,tsconfig.json,src/index.ts,src/types.ts,src/client/index.ts,src/client/service.ts,tests/controller.host.spec.ts,tests/service.client.spec.ts,README.md,README.zh.md}.

**Interfaces:** Consumes the Shared API and both providers. Produces service_list/service_logs/service_control, pure Host presenters and persisted metadata, authenticated remote.projectServices list/logs/control/follow, and a framework-neutral client observable service.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

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

Test native and Docker read authorization, group audit with all targets, rejected/missing authorizer, sandbox/approval changes, mismatched execution identity, foreign projects, bounded logs, canonical schemas, replay presentation without live queries, and baseline/reconnect subscription behavior. Read current policy semantics before implementing automatic read grants; a known project does not grant Docker or cross-Session log access.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm exec vitest run packages/workspace/tool-project-services/tests packages/api/project-services-controller/tests
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
const operationPolicy = currentPolicy(exec.agent.session)
const outcome = await ctx.approval.request({agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: describeAllTargets(operation), signal})
if (outcome !== 'allowed-once') throw new Error('Service operation not authorized')
assertPolicyUnchanged(operationPolicy, currentPolicy(exec.agent.session))
signal.throwIfAborted()
```

Construct ServiceAccess only inside trusted consumers. The controller resolves WorkspaceId through workspaceRegistry; tools derive cwd from the current Session. Run default tool admission plus resolved-target approval for every agent mutation. Keep read filtering explicit for lists, logs, operation outcomes and subscriptions. Approval reasons include all concrete actions/targets, reject oversized groups instead of truncating. Use the current scoped shell and sandbox policy but verify its process provider is Host-lived. Register only short tool guidance; snapshots reach models solely through normal tool results. Generate Typert declarations and use split Host/Client configs.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: agent tools and authenticated remote api` as the commit subject; fix important findings before the next task.

### Task 5: Project service panel and application composition

**Files:** Create packages/client/ui-project-services/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts,src/client/index.ts,src/client/ServicesPanel.tsx,src/client/locales.ts,src/client/styles.module.css,tests/panel.client.spec.tsx,README.md,README.zh.md}. Extend ui-workspace row action slots/contracts, package docs and tests; update bundle/web-app composition/dependencies and Host/Client aggregate references.

**Interfaces:** Consumes remote.projectServices and its client observable API. Produces the Workspace Services entry, root main panel, checkout/provider filtering, definition creation, native/container/Compose rows, logs, approved actions, group progress and localized tool cards.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

```text
it('keeps native services visible when Docker becomes unavailable', async () => {
  renderServicesPanel(nativeAndDockerSnapshot)
  publishSnapshot(dockerUnavailableSnapshot)
  expect(screen.getByText('frontend')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Docker unavailable')
})
```

Test Workspace entry with no open Session, native start validation, Docker individual/group actions, missing capabilities, stale rows, shared grouping, no-healthcheck display, log truncation, independent readers, canceled navigation and reconnect. UI tests use localized props/dictionaries and assert accessible behavior, not class names.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm exec vitest run packages/client/ui-project-services/tests packages/client/ui-workspace/tests
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
ctx.slots.inject('main', () => ctx.slots.register('main', {key: 'project-services', component: ServicesPanel, inject: panelDependencies}))
ctx.layout.selectPanel('project-services')
```

Use existing slot, store and locale patterns; components receive data/callbacks through framework props and subscribe through framework hooks. Add an extensible Workspace action slot instead of importing this feature into ui-workspace. Reuse primitives and semantic CSS tokens. The UI never equates running with healthy, never opens container-private addresses as localhost, and preserves read-only rows with clear capability reasons. Mount local runtime, optional Docker, controller/client and UI in the supported local profile; agent tools must be available in its agent composition without altering headless defaults unintentionally.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: project service panel and application composition` as the commit subject; fix important findings before the next task.

### Task 6: Recorded and real-flow acceptance

**Files:** Add profile-based keyless service scenarios and owner-local browser/Docker integration fixtures using the existing harness; update affected subsystem pages, READMEs, generated catalogs, persistence acknowledgements when required, and one durable architecture Agent Note with bilingual records.

**Interfaces:** Consumes the assembled feature. Produces evidence that GUI and agent share service state, local processes and Docker operate under the same project scope, shutdown preserves container lifetime, and replay renders historical outcomes without querying live resources.

- [ ] **Step 1: Add a failing behavior regression.** Establish the following behavior through real production consumers; fixture helpers named in this example belong in this task’s test files.

```text
expect(agentListedIds).toContain(guiStartedInstanceId)
expect(await panelStatus(agentRestartedInstanceId)).toBe('running')
expect(await dockerContainerExists(containerId)).toBe(true)
```

Use a main checkout and external worktree, a native loopback service, a standalone container and replicated Compose fixtures. Test list/log/start/restart/stop, denied and stale operations, Docker-unavailable UI, and post-Host-shutdown container survival. Record tool/PTC outputs and browser expected outputs under their correct owning harness. Never use ambient user services as fixtures.

- [ ] **Step 2: Observe the regression fail for the missing behavior.**

```sh
pnpm run test:gui
```

- [ ] **Step 3: Implement the task with these operation relationships.**

```text
await launchSupportedDshProfile(testOverlay)
await verifyGuiAndAgentOperations()
await verifyDockerFixtures()
await recordRealFlowGif()
await disposeOwnedFixturesAndAwaitQuiescence()
```

Run focused tests first, then generated source checks/typecheck, relevant built smokes, scoped keyless snapshots and browser replay. Launch browser automation with the repository directory-picker overlay. Record a real server/model flow GIF using record-browser-gif, and explicitly report any missing real-model or Docker evidence. Run doc-sync and relevant lint/hygiene after manifests/catalogs settle. Existing Comet missing-pair/link failures are baseline issues; do not fold them into this feature. Finish with one broad independent branch review and fixes before delivery; do not push, merge or publish without user authorization.

- [ ] **Step 4: Re-run the focused command, inspect actual results, and validate the changed package contracts.** Record exact evidence and any platform skips in the task report.

- [ ] **Step 5: Commit the task-scoped diff and request independent task review.** Use `feat: recorded and real-flow acceptance` as the commit subject; fix important findings before the next task.
