# Agent Note: Personal-account issue automation

Status: implemented

[English](2026-10-20-personal-account-issue-automation.md) | 中文

## 问题

Issue policy 与 lifecycle 工作流最初通过 GitHub App 安装 token 操作组织 Project。`SmallNew2003/zhiliao` 归个人账号所有，而 GitHub App 安装 token 无法写入个人拥有的 ProjectsV2。fine-grained personal access token 也没有所需的个人 Project 权限。个人账号仓库还会通过 REST 列出默认 Issue Types，却静默丢弃所有类型应用请求。因此保留上游的 owner、repository、token 与 Type 要求，会让同步后的工作流读取错误账号，或者在 Project 校验前失败。

## 决策

[config.json](../../../../.github/issue-management/config.json)直接指定个人 owner 与 repository。[github.mjs](../../../../.github/issue-management/github.mjs)通过 `repository.projectV2` 解析配置的 Project，使 Project 保持个人所有并链接到仓库。

工作流仅在仓库变量 `DSH_ISSUE_MANAGEMENT_ENABLED` 为 `true` 时运行。仓库 Issue 的读取与写入使用工作流 `GITHUB_TOKEN` 及其显式权限。ProjectV2 的读取与写入使用 `DSH_PROJECT_TOKEN`，它是具有 `project` scope、存储在仓库 secret 中的 classic personal access token。工作流不再包含 App client ID、App private key 或上游 owner。

Project 为私有，链接到 `SmallNew2003/zhiliao`，并具有配置的 `Status`、`Priority` 与 `Start Date` 字段。Project mutation 归属于 `SmallNew2003`，因此 `lifecycleActor` 使用该登录名。终态与向前状态转换规则仍保留；actor 专属的 `In review` 保护无法区分同一账号执行的人工修改与自动修改。

`requireIssueType` 为 `false`，因为 GitHub 无法在该个人仓库保存原生 Issue Type。Issue 审计仍检查 Project 归属、Status、Priority、终态一致性以及保留标签。

## 验证

[policy.test.mjs](../../../../.github/issue-management/policy.test.mjs)固定 `repository.projectV2` 查询、owner 变量、仓库路径、Project 字段与工作流凭据接线。[ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts)固定仓库变量门、显式工作流权限，以及 `GITHUB_TOKEN` 与 `DSH_PROJECT_TOKEN` 的分离。

## 曾考虑的替代方案

**保留 GitHub App token。** 它能保留 bot 身份，但无法写入个人 Project，因此生命周期状态更新仍会失败。

**使用 fine-grained personal access token。** 它无法为 ProjectsV2 提供个人 Project scope，因此不能替代该 owner 类型下的 classic token。

**创建或迁移到组织 Project。** 这能保留短期 App token 与 bot 归属，但需要组织，并需要复制 Project 或转移仓库，超出本次 fork 内修复的范围。

**继续跳过工作流。** 上游守卫能让检查变绿，但 Issue policy 与 lifecycle 仍不可用。用户选择个人 Project 路径，使自动化真正运行。

**继续要求原生 Issue Type。** REST 端点让该要求看起来可用，但 GraphQL 不返回仓库类型，赋值结果也始终为 null。继续要求它会使每条个人 Issue 审计失败，且没有修复路径。

## 后果

仓库现在持有一个长期 Project 凭据，必须在到期前轮换。其 `project` scope 比宽泛的仓库 PAT 更窄，值只保存在 GitHub Actions secret 中，不进入源码。

状态变更归属于 token 所有者。该账号的人工与自动变更在 Project 时间线中无法区分，削弱了原有的人工归属保护。若需要完全等价的行为，替代方案是由 bot 身份操作的组织 Project。

个人 Issue 没有原生 Type。分类必须来自 Issue 内容、标签或 Project 字段，而不是上游的 Type 契约。
