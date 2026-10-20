# Agent Note: Personal-account issue automation

Status: implemented

English | [中文](2026-10-20-personal-account-issue-automation.zh.md)

## Problem

The Issue policy and lifecycle workflows originally targeted an organization Project through a GitHub App installation token. `SmallNew2003/zhiliao` is owned by a user, and GitHub App installation tokens cannot write user-owned ProjectsV2. Fine-grained personal access tokens do not expose the required user Project permission either. Personal-account repositories also list default Issue Types through REST while silently dropping every attempt to apply one. Keeping the upstream owner, repository, token, and Type requirements therefore made synchronized workflows read the wrong account or fail validation.

## Decision

[config.json](../../../../.github/issue-management/config.json) names the user owner and repository directly. [github.mjs](../../../../.github/issue-management/github.mjs) resolves the configured Project through `repository.projectV2`, so the Project remains linked to the repository while staying user-owned.

The workflows run only when the repository variable `DSH_ISSUE_MANAGEMENT_ENABLED` is `true`. Repository Issue reads and writes use the workflow `GITHUB_TOKEN` with explicit permissions. ProjectV2 reads and writes use `DSH_PROJECT_TOKEN`, a classic personal access token with the `project` scope stored as a repository secret. No App client ID, App private key, or upstream owner remains in the workflow.

The Project is private, linked to `SmallNew2003/zhiliao`, and has the configured `Status`, `Priority`, and `Start Date` fields. Project mutations are attributed to `SmallNew2003`, so `lifecycleActor` names that login. The terminal-status and forward-transition rules remain; the actor-specific `In review` protection cannot distinguish a human change from an automated change made by the same account.

`requireIssueType` is `false` because GitHub cannot store native Issue Types on this personal repository. Issue audit still checks Project membership, Status, Priority, terminal-state alignment, and reserved labels.

## Verification

[policy.test.mjs](../../../../.github/issue-management/policy.test.mjs) pins the `repository.projectV2` query, owner variables, repository paths, Project fields, and workflow credential wiring. [ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts) pins the repository-variable gate, explicit workflow permissions, and separation of `GITHUB_TOKEN` from `DSH_PROJECT_TOKEN`.

## Alternatives considered

**Keep the GitHub App token.** It preserves a bot identity but cannot write a user-owned Project, so lifecycle status updates would still fail.

**Use a fine-grained personal access token.** It cannot expose a personal Project scope for ProjectsV2, so it cannot replace the classic token for this owner type.

**Create or move to an organization Project.** This preserves the short-lived App token and bot attribution, but it requires an organization and either a project copy or repository transfer that is outside this fork-local repair.

**Leave the workflows skipped.** The upstream guard made checks green but kept Issue policy and lifecycle unavailable. The user selected the personal Project path so automation can run.

**Keep a required native Issue Type.** The REST endpoint makes the requirement look available, but GraphQL returns no repository types and assignments remain null. Keeping the requirement would make every personal Issue fail audit without a remediation path.

## Consequences

The repository now owns a long-lived project credential that must be rotated before expiry. Its `project` scope is narrower than a broad repository PAT, and the value remains in GitHub Actions secrets rather than source.

Status changes are attributed to the token owner. Manual and automated changes by that account are indistinguishable in the Project timeline, which weakens the original human-ownership protection. The alternative needed for exact parity is an organization Project backed by a bot identity.

Personal Issues have no native Type. Classification must come from Issue content, labels, or Project fields instead of the upstream Type contract.
