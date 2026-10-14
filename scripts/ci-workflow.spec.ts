import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function evaluateRunsOn(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Runner selector must be a string')
  return runInNewContext(selector.trim().slice(3, -2), context, { timeout: 1000 })
}

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'

describe('CI workflow', () => {
  it.each(['ci.yml', 'ci-master.yml', 'e2e.yml', 'release.yml', 'release-vendor.yml'])(
    '%s cancels superseded validation runs without crossing workflow or ref boundaries', (name) => {
      const workflow = loadWorkflow('.github/workflows/' + name)
      expect(workflow.concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.ref }}',
        'cancel-in-progress': true,
      })
    },
  )

  it('cancels reusable CI builds without cancelling release-owned builds', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(workflow.concurrency).toEqual({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': '${{ !inputs.release }}',
    })
  })

  it('does not cancel protected publication or deployment transactions', () => {
    for (const name of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const publish = workflowJob(loadWorkflow('.github/workflows/' + name), 'publish')
      expect(publish.concurrency).toMatchObject({ 'cancel-in-progress': false })
    }
    for (const name of ['python-release.yml', 'node-addon-system-release.yml', 'docs-pages.yml']) {
      expect(loadWorkflow('.github/workflows/' + name).concurrency).toMatchObject({ 'cancel-in-progress': false })
    }
  })

  it('skips coverage-history uploads on cancellation but retains Wine cleanup', () => {
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'windows-coverage')
    const wine = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'windows')
    expect(coverage.steps).toContainEqual(expect.objectContaining({
      name: 'Save coverage duration history', if: '${{ !cancelled() }}',
    }))
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-master.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      if (jobName.startsWith('windows-')) {
        expect(stepDest, `${jobName} must use the native Windows pnpm destination`).toBe(nativeWindowsPnpmDestination)
        expect(step).not.toMatchObject({ with: { standalone: true } })
      } else {
        expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
        expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
      }
    }
  })

  it.each(['node-24', 'node-24-coverage', 'node-24-consumers'])(
    '%s keeps tool and fixture temporary files under runner cleanup',
    (jobName) => {
      const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job.steps[0]).toEqual({
        name: 'Use runner-owned temporary storage',
        run: [
          'echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"',
          ...(jobName === 'node-24-consumers'
            ? ['echo "PLAYWRIGHT_BROWSERS_PATH=${RUNNER_TEMP%/*}/ms-playwright" >> "$GITHUB_ENV"']
            : []),
          '',
        ].join('\n'),
      })
      if (jobName === 'node-24-consumers') {
        const browserCache: unknown = job.steps.find(step => isRecord(step) && isRecord(step.with)
          && step.with.path === '${{ env.PLAYWRIGHT_BROWSERS_PATH }}')
        expect(browserCache).toMatchObject({ uses: 'actions/cache/restore@v4' })
      }
      const store: unknown = job.steps.find(step => isRecord(step) && step.name === 'Configure pnpm store path')
      expect(store).toMatchObject({
        run: [
          'store_root="$HOME/.local/share/pnpm/store"',
          'echo "PNPM_CONFIG_STORE_DIR=$store_root" >> "$GITHUB_ENV"',
          'store_path=$(PNPM_CONFIG_STORE_DIR="$store_root" pnpm store path --silent)',
          'echo "path=$store_path" >> "$GITHUB_OUTPUT"',
          '',
        ].join('\n'),
      })
      for (const step of job.steps) {
        if (isRecord(step) && isRecord(step.env)) {
          expect(step.env.TMPDIR).toBeUndefined()
          expect(step.env.npm_config_cache).toBeUndefined()
        }
      }
    },
  )

  it('isolates the python SDK exe pnpm setup destination per job', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('build-exe-for-python-sdk.yml must define jobs')
    const setups: Array<{ step: unknown }> = []
    for (const job of Object.values(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps) {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
        setups.push({ step })
      }
    }
    expect(setups.length).toBeGreaterThan(0)
    for (const { step } of setups) {
      expect(step).toMatchObject({
        with: { dest: nativeWindowsPnpmDestination },
      })
    }
  })

  it('runs every blocking PR lane on a standard hosted runner without failover switches', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')
    const blocking = ['node-24', 'node-24-coverage', 'node-24-consumers', 'node-compat', 'python-sdk', 'windows-build', 'windows-coverage'] as const
    for (const jobName of [...blocking, 'all-checks-passed']) {
      workflowJob(workflow, jobName)
    }
    const node24 = workflowJob(workflow, 'node-24')
    const node24Coverage = workflowJob(workflow, 'node-24-coverage')
    const node24Consumers = workflowJob(workflow, 'node-24-consumers')
    const windowsBuild = workflowJob(workflow, 'windows-build')
    const windowsCoverage = workflowJob(workflow, 'windows-coverage')
    const aggregate = workflowJob(workflow, 'all-checks-passed')

    expect(node24.name).toBe('node 24 / static')
    expect(node24Coverage.name).toBe('node 24 / coverage')
    expect(node24Consumers.name).toBe('node 24 / snapshots and artifacts')
    expect(windowsBuild.name).toBe('windows node 24 / build')
    expect(windowsCoverage.name).toBe('windows node 24 / coverage')

    // This repository carries no enterprise or self-hosted pool, so every lane
    // must name a label GitHub schedules for free. A reintroduced pool
    // expression would queue forever on a label no runner answers. Reusable
    // workflow calls own their own runner selection.
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || typeof job.uses === 'string') continue
      expect(job['runs-on'], `${jobName} must use a standard hosted label`).toBe(
        jobName.startsWith('windows-') ? 'windows-latest' : 'ubuntu-latest',
      )
    }
    // The pool selectors are gone from runner selection. Self-hosted guards
    // inside a step stay valid: they only arm when a persistent runner is
    // registered, and this repository has none, so they never fire.
    expect(JSON.stringify(workflow)).not.toContain('DSH_CI_FAILOVER')
    expect(JSON.stringify(workflow)).not.toContain('blacksmith')

    // The verdict is the single stable required check: it must name every
    // blocking job and nothing else, so a new lane cannot silently skip it.
    expect(aggregate.needs).toEqual([...blocking])
    expect(aggregate['runs-on']).toBe('ubuntu-latest')

    // The two native Windows installs branch on the workspace filesystem:
    // clone (ReFS block clone) only on ReFS, plain install elsewhere. This
    // keeps the TS6231 store-path leak (see the Windows ReFS store note) out
    // of hosted NTFS, which rejects copy-on-write.
    for (const [jobName, job] of [['windows-build', windowsBuild], ['windows-coverage', windowsCoverage]] as const) {
      const steps = job.steps as unknown[]
      const developerMode = steps.find((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && typeof step.run === 'string' && step.run.includes('AllowDevelopmentWithoutDevLicense')
      ))
      expect(developerMode, `${jobName} must enable Developer Mode for symlinks`).toBeDefined()
      const install = steps.find((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && step.name === 'Install (immutable)' && typeof step.run === 'string'
      ))
      expect(install, `${jobName} must define the filesystem-branched install`).toBeDefined()
      expect(install!.run).toContain("$fs -eq 'ReFS'")
      expect(install!.run).toContain('--package-import-method=clone')
      expect(install!.run).toContain('corepack pnpm install')
      // The else branch must keep the plain hosted install as a distinct line
      // (not the corepack clone line, which contains the same substring);
      // dropping it or making both branches clone would force clone onto
      // NTFS, which rejects copy-on-write (ERR_PNPM_LINKING_FAILED). The
      // YAML folded block keeps the first statement on line 1 and folds the
      // rest with leading two-space indents.
      const installLines = install!.run.split('\n').map(line => line.trim())
      expect(installLines).toContain('} else {')
      expect(installLines.some(line => line === 'pnpm install --frozen-lockfile'), `${jobName} else branch must keep the plain hosted install`).toBe(true)
      // The ReFS branch must not use the interpolated empty-flag form, which
      // passes a stray "" positional argument to pnpm.
      expect(install!.run).not.toContain('$cloneFlag')
    }

    expect(windowsBuild.steps).toContainEqual({
      name: 'Run blocking Windows builds',
      shell: 'pwsh',
      run: 'pnpm run check:ci:windows-blocking',
    })

    // Both coverage lanes share the standard-runner partition profile and keep
    // the measured-duration cache that weights partitions on later runs.
    for (const [jobName, job] of [['node-24-coverage', node24Coverage], ['windows-coverage', windowsCoverage]] as const) {
      expect(job.env, `${jobName} partition profile`).toMatchObject({
        DSH_COVERAGE_PARTITIONS: '2',
        DSH_COVERAGE_TEST_TIMEOUT_MS: '90000',
        DSH_GATE_FAIL_FAST: '1',
      })
      const steps = job.steps as unknown[]
      expect(steps).toContainEqual(expect.objectContaining({
        name: 'Save coverage duration history', if: '${{ !cancelled() }}',
      }))
      const restore = steps.find((step): step is Record<string, unknown> => (
        isRecord(step) && step.name === 'Restore coverage duration history'
      ))
      expect(restore, `${jobName} must restore the duration history`).toBeDefined()
    }

    // Windows coverage runs zero-build like the Linux lane: workspace imports
    // resolve to src through the tsconfig paths map, and the lib-consuming
    // suites (webworker-packer image-loadable, webworker-runtime
    // transform-corpus, client ui-trajectory client-bundle) self-skip on
    // unbuilt checkouts. The regex catches a regression spelled as
    // 'corepack pnpm run build' or folded into a multi-line run block, which
    // an exact string match would miss.
    const coverageCommands = (windowsCoverage.steps as unknown[])
      .filter((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && typeof step.run === 'string'
      ))
      .map(step => step.run)
    expect(coverageCommands).toContain('pnpm run check:ci:coverage')
    expect(coverageCommands.every(command => !/\bpnpm\s+run\s+build(?:\s|$)/.test(command))).toBe(true)

    // The run-gates aggregate lanes stop at the first blocking gate failure so
    // a red aggregate does not keep burning runner time on the remaining
    // gates. Removing the flag silently reverts to running every independent
    // gate to completion.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers], ['windows-build', windowsBuild], ['windows-coverage', windowsCoverage]] as const) {
      expect(job.env, `${jobName} must enable fail-fast`).toMatchObject({ DSH_GATE_FAIL_FAST: '1' })
    }

    // ci-consumers defaults to one worker per gate, which oversubscribes the
    // standard runner's CPU count because the build gate alone drives tsc.
    expect(node24Consumers.env).toMatchObject({ DSH_GATE_CONCURRENCY: '3' })
    const consumersConcurrency = Number.parseInt(
      String((node24Consumers.env as Record<string, unknown>).DSH_GATE_CONCURRENCY),
      10,
    )
    expect(consumersConcurrency).toBeLessThanOrEqual(4)

    // The verdict reports a failure when any needed job failed, was cancelled,
    // or was skipped, so a lane dropped from `needs` cannot pass silently.
    const verdict = (aggregate.steps as unknown[]).find((step): step is Record<string, unknown> & { if: string } => (
      isRecord(step) && step.name === 'Fail if any needed job did not succeed'
    ))
    expect(verdict).toBeDefined()
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(verdict!.if).toContain(result)
    }
  })

  it('gates standalone keyless jobs on the failover variables', () => {
    const expectedFilenames = workflowJob(loadWorkflow('.github/workflows/expected-filenames.yml'), 'expected-filenames')
    const sandbox = workflowJob(loadWorkflow('.github/workflows/sandbox.yml'), 'sandbox-e2e')
    expect(expectedFilenames['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(expectedFilenames['runs-on']).toContain("== 'blacksmith'")
    expect(expectedFilenames['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    expect(expectedFilenames['runs-on']).toContain("'ubuntu-latest'")
    expect(sandbox['runs-on']).toContain("matrix.runner == 'bwrap'")
    expect(sandbox['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(sandbox['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
  })


  it('gives the Wine Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
  })

  it('cancels superseded master runs without changing the post-merge job inventory', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(prWorkflow.concurrency).toEqual(workflow.concurrency)

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master) + workflow_dispatch and
    // never on pull_request; ci.yml is exactly pull_request-only. Assert the
    // full sets so losing the wrong event, or gaining an extra one, fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on)).toEqual(['pull_request'])

    // Pin the post-merge inventory: the Wine lane plus two manual references.
    // A push reaches exactly the gated lane; the release-shaped runtime
    // carriers need a real API credential, so they stay manual.
    const MANUAL_ONLY = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'serial-macos'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'python-runtime'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !MANUAL_ONLY.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['windows'])

    // Every post-merge lane also resolves to a label this repository can
    // schedule: no enterprise or self-hosted pool survives the migration.
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || typeof job.uses === 'string') continue // reusable workflow owns its own runners
      expect(job['runs-on'], `${jobName} must use a standard hosted label`).toBe(
        jobName === 'windows' ? 'ubuntu-latest' : 'macos-latest',
      )
    }
    expect(JSON.stringify(workflow)).not.toContain('DSH_CI_FAILOVER')
    expect(JSON.stringify(workflow)).not.toContain('self-hosted')
    expect(JSON.stringify(workflow)).not.toContain('blacksmith')
  })

  it('redirects the Node compile cache to the data-volume runner temp before the first pnpm call', () => {
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    const redirectLanes = [
      [prWorkflow, 'node-24'],
      [prWorkflow, 'node-24-coverage'],
      [prWorkflow, 'node-24-consumers'],
    ] as const
    for (const [workflow, jobKey] of redirectLanes) {
      const job = workflowJob(workflow, jobKey)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobKey} must define steps`)
      const redirectStepIndex = job.steps.findIndex((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && typeof step.run === 'string'
          && step.run.includes('NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache')
          && step.run.includes('"$GITHUB_ENV"')
      ))
      // Removing this injection would send every pnpm call in the lane (setup,
      // store-path probe, install, and the gate) back to the root partition's
      // /tmp; rationale in
      // .agents/notes/implemented/process/2026-08-28-ci-node-compile-cache-data-disk.md.
      expect(redirectStepIndex, `${jobKey} must inject NODE_COMPILE_CACHE into GITHUB_ENV`).toBeGreaterThan(-1)
      const pnpmSetupIndex = job.steps.findIndex((step): step is Record<string, unknown> & { uses: string } => (
        isRecord(step) && typeof step.uses === 'string' && step.uses.includes('pnpm/action-setup')
      ))
      expect(pnpmSetupIndex, `${jobKey} must run pnpm/action-setup`).toBeGreaterThan(-1)
      expect(redirectStepIndex, `${jobKey} must redirect before pnpm/action-setup runs pnpm`).toBeLessThan(pnpmSetupIndex)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })


  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('Runtime and LLM e2e Blacksmith routing', () => {
  it('routes DeepSeek e2e only through the Linux Blacksmith switch', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/e2e.yml'), 'e2e')
    for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: mode, DSH_CI_FAILOVER_WINDOWS: 'blacksmith' } }))
        .toBe(mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
    }
  })

  it('keeps native release and dispatch builders hosted while routing x64 CI by platform', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    for (const [target, runner, variable, blacksmith] of [
      ['node24-linux-x64', 'ubuntu-latest', 'DSH_CI_FAILOVER_LINUX', 'blacksmith-16vcpu-ubuntu-2404'],
      ['node24-win-x64', 'windows-2025', 'DSH_CI_FAILOVER_WINDOWS', 'blacksmith-16vcpu-windows-2025'],
      ['node24-linux-arm64', 'ubuntu-24.04-arm', 'DSH_CI_FAILOVER_LINUX', 'ubuntu-24.04-arm'],
      ['node24-macos-arm64', 'macos-latest', 'DSH_CI_FAILOVER_LINUX', 'macos-latest'],
      ['node24-macos-x64', 'macos-15-intel', 'DSH_CI_FAILOVER_LINUX', 'macos-15-intel'],
    ] as const) {
      for (const ci of [false, true]) {
        for (const release of [false, true]) {
          for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
            const vars = { DSH_CI_FAILOVER_LINUX: 'blacksmith', DSH_CI_FAILOVER_WINDOWS: 'blacksmith', [variable]: mode }
            expect(evaluateRunsOn(build['runs-on'], { inputs: { ci, release }, vars, matrix: { target, runner } }), `${target} ci=${ci} release=${release} mode=${mode}`)
              .toBe(ci && !release && mode === 'blacksmith' ? blacksmith : runner)
          }
        }
      }
    }
  })

  it.each(['plan', 'sdk-wheel'])('routes runtime %s only for non-release CI', (name) => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), name)
    for (const ci of [false, true]) {
      for (const release of [false, true]) {
        for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
          expect(evaluateRunsOn(job['runs-on'], { inputs: { ci, release }, vars: { DSH_CI_FAILOVER_LINUX: mode } }))
            .toBe(ci && !release && mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
        }
      }
    }
  })
})

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })

  it('bounds profile subprocess fan-out to the tested e2e default', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const step = e2e.steps.filter(isRecord).find(candidate => candidate.name === 'E2E tests (real DeepSeek API)')
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 4 } })
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    if (!isRecord(workflow.on)) throw new TypeError('python-release workflow must define on')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(build).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(Object.keys(workflow.on as Record<string, unknown>).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !isRecord(call.secrets) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS payload architecture and deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    const cleanVenvPosix = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (POSIX)')
    const cleanVenvWindows = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (Windows)')
    const installedKeylessPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (POSIX)')
    const installedKeylessWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (Windows)')
    const realApiPreflightPosix = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (POSIX)')
    const realApiPreflightWindows = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (Windows)')
    const installedRealApiPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (POSIX)')
    const installedRealApiWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (Windows)')
    if (!isRecord(macosCheck) || typeof macosCheck.run !== 'string'
      || !isRecord(cleanVenvPosix) || !isRecord(cleanVenvWindows)
      || !isRecord(installedKeylessPosix) || !isRecord(installedKeylessWindows)
      || !isRecord(realApiPreflightPosix) || !isRecord(realApiPreflightWindows)
      || !isRecord(installedRealApiPosix) || !isRecord(installedRealApiWindows)) {
      throw new TypeError('Python wheel builder must define native POSIX and Windows installed-wheel steps')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(call.secrets).toMatchObject({
      DEEPSEEK_API_KEY_EXTERNAL: { required: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(build.defaults).toBeUndefined()
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('macosx_14_0_x86_64')
    expect(workflowJson).toContain('node24-macos-x64')
    expect(workflowJson).toContain('macos-15-intel')
    expect(workflowJson).toContain('win_amd64')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(workflowJson).not.toContain('cygpath')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('pnpm_setup_root')
    expect(JSON.stringify(manylinuxAddon)).toContain('$pnpm_setup_root:$pnpm_setup_root:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(macosCheck.run).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck.run).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck.run).toContain('$EXE-rg')
    expect(macosCheck.run).toContain('$EXE-spawn-helper')
    expect(JSON.stringify(installedKeylessPosix)).toContain('--scenario all')
    expect(JSON.stringify(installedKeylessPosix)).toContain('env -u PYTHONPATH')
    expect(JSON.stringify(installedKeylessWindows)).toContain('--scenario all --installed-wheel')
    expect(installedKeylessWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(cleanVenvWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(JSON.stringify(cleanVenvWindows)).toContain('Scripts\\\\python.exe')
    expect(realApiPreflightPosix).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(String(realApiPreflightPosix.if)).toContain('inputs.ci')
    expect(String(realApiPreflightPosix.if)).toContain('head.repo.fork')
    expect(String(realApiPreflightPosix.if)).toContain('dependabot[bot]')
    expect(realApiPreflightWindows).toMatchObject({ shell: 'pwsh' })
    for (const step of [installedRealApiPosix, installedRealApiWindows]) {
      expect(step).toMatchObject({
        env: {
          DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
        },
      })
    }
    expect(JSON.stringify(installedRealApiPosix)).toContain('--scenario sdk-live')
    expect(JSON.stringify(installedRealApiPosix)).toContain('-u DSH_RUNTIME_MODE')
    expect(installedRealApiWindows).toMatchObject({ shell: 'pwsh' })
    expect(JSON.stringify(installedRealApiWindows)).toContain('--scenario sdk-live --installed-wheel')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Weighted approval workflow', () => {
  it('publishes from the trusted default branch after pull request and review updates', () => {
    const publisher = loadWorkflow('.github/workflows/weighted-approval.yml')
    const reviewEvent = loadWorkflow('.github/workflows/weighted-approval-review-event.yml')
    const pullRequest = workflowEvent(publisher, 'pull_request_target')
    const workflowRun = workflowEvent(publisher, 'workflow_run')
    const review = workflowEvent(reviewEvent, 'pull_request_review')
    const job = workflowJob(publisher, 'publish-status')
    const recordJob = workflowJob(reviewEvent, 'record-review-event')
    if (!isRecord(publisher.on)) throw new TypeError('weighted-approval workflow must define events')
    if (!isRecord(reviewEvent.on)) throw new TypeError('weighted-approval review event workflow must define events')
    if (!Array.isArray(job.steps)) throw new TypeError('weighted-approval job must define steps')
    if (!Array.isArray(recordJob.steps)) throw new TypeError('weighted-approval review event job must define steps')
    const steps = job.steps.filter(isRecord)
    const checkout = steps.find(step => step.name === 'Check out trusted approval policy')
    const publish = steps.find(step => step.name === 'Publish weighted approval status')
    const recordSteps = recordJob.steps.filter(isRecord)
    const record = recordSteps.find(step => step.name === 'Record review event')

    expect(publisher.name).toBe('weighted-approval')
    expect(Object.keys(publisher.on)).toEqual(['pull_request_target', 'issue_comment', 'workflow_run'])
    expect(workflowEvent(publisher, 'issue_comment').types).toEqual(['created', 'edited', 'deleted'])
    expect(pullRequest.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited'])
    expect(workflowRun).toEqual({ workflows: ['weighted-approval-review-event'], types: ['completed'] })
    expect(reviewEvent.name).toBe('weighted-approval-review-event')
    expect(reviewEvent['run-name']).toBe('weighted-approval-review-event:${{ github.event.pull_request.number }}')
    expect(Object.keys(reviewEvent.on)).toEqual(['pull_request_review'])
    expect(review.types).toEqual(['submitted', 'edited', 'dismissed'])
    expect(reviewEvent.permissions).toEqual({})
    expect(publisher.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      statuses: 'write',
    })
    expect(publisher.concurrency).toEqual({
      group: "weighted-approval-${{ (github.event.pull_request.number || github.event.issue.number) && format('weighted-approval-review-event:{0}', github.event.pull_request.number || github.event.issue.number) || github.event.workflow_run.display_title }}",
      'cancel-in-progress': false,
    })
    expect(job).toMatchObject({
      if: "(github.event_name != 'pull_request_target' || github.event.pull_request.state == 'open') && "
        + "(github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success') && "
        + "(github.event_name != 'issue_comment' || (github.event.issue.pull_request && github.event.issue.state == 'open' &&\n"
        + "  (contains(github.event.comment.body, '/delegate') || contains(github.event.changes.body.from, '/delegate'))))",
      name: 'weighted approval publisher',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
    })
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: '${{ github.event.repository.default_branch }}',
        'persist-credentials': false,
      },
    })
    const setupIndex = steps.findIndex(step => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-python@'))
    expect(steps[setupIndex]?.if).toBe("steps.revoke.outputs.active == 'true'")
    expect(steps[setupIndex]?.uses).toBe('actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1')
    const revokeIndex = steps.findIndex(step => step.id === 'revoke')
    expect(revokeIndex).toBeGreaterThan(steps.indexOf(checkout!))
    expect(revokeIndex).toBeLessThan(setupIndex)
    expect(steps[revokeIndex]?.run).toBe('node .github/review-ownership/check-approval.mjs pending')
    expect(steps.at(-1)).toMatchObject({
      if: "failure() && steps.revoke.outputs.active == 'true'",
      run: 'node .github/review-ownership/check-approval.mjs error',
    })
    const pythonJob = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'python-sdk')
    expect(pythonJob.steps).toContainEqual({
      name: 'Test production blame scoring',
      run: "uv run --python 3.10 --with-requirements .github/review-ownership/requirements.txt python -m unittest discover -s .github/review-ownership -p 'test_*.py'",
    })
    expect(steps.find(step => step.name === 'Install production lexer')).toMatchObject({
      if: "steps.revoke.outputs.active == 'true'",
      run: 'python3 -m pip install -r .github/review-ownership/requirements.txt',
    })
    expect(publish).toMatchObject({
      if: "steps.revoke.outputs.active == 'true'",
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        GITHUB_RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
      },
      run: 'node .github/review-ownership/check-approval.mjs',
    })
    expect(recordJob).toMatchObject({
      if: "github.event.pull_request.state == 'open'",
      name: 'record weighted approval review event',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 2,
    })
    expect(record).toBeDefined()
    expect(record?.run).toBe("echo 'Recorded a weighted approval review event.'")
    expect(recordSteps).toHaveLength(1)
    expect(JSON.stringify(publisher)).not.toContain('github.event.pull_request.head')
    expect(JSON.stringify(publisher)).not.toContain('secrets.')
    expect(JSON.stringify(reviewEvent)).not.toContain('github.token')
    expect(JSON.stringify(reviewEvent)).not.toContain('secrets.')
  })
})

describe('Issue lifecycle workflow', () => {
  it('allocates lifecycle runners only for events that can change the board', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    expect(lifecycleJob.if).toContain("github.event.review.state == 'changes_requested'")
    expect(lifecycleJob.if).toContain('github.event.changes.body != null')
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).toContain('opened')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecyclePullRequest.types).not.toContain('synchronize')
    expect(lifecyclePullRequest.types).not.toContain('labeled')
    expect(lifecyclePullRequest.types).not.toContain('unlabeled')
    const issueEvents = workflowEvent(lifecycle, 'issues')
    expect(issueEvents.types).not.toContain('assigned')
    expect(issueEvents.types).not.toContain('unassigned')
    expect(issueEvents.types).toContain('typed')
    expect(issueEvents.types).toContain('untyped')
    const steps = lifecycleJob.steps.filter(isRecord)
    const tokenStep = steps.find(s => s.name === 'Create project token')
    const handleStep = steps.find(s => s.name === 'Handle repository event')
    expect(tokenStep?.if).toBeUndefined()
    expect(handleStep?.if).toBeUndefined()

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })

  it('mints Project credentials only after preflight and always revalidates current metadata', () => {
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyJob = workflowJob(policy, 'policy')
    if (!Array.isArray(policyJob.steps)) throw new TypeError('Issue policy job must define steps')
    const steps = policyJob.steps.filter(isRecord)
    const tokenStep = steps.find(step => step.name === 'Create Project read token')
    const validateStep = steps.find(step => step.name === 'Validate pull request')
    const preflightStep = steps.find(step => step.id === 'preflight')
    expect(preflightStep).toMatchObject({ shell: 'bash' })
    expect(preflightStep?.run).toContain('if [ -f .github/issue-management/selective-preflight.json ]; then')
    expect(preflightStep?.run).toContain('node .github/issue-management/policy.mjs pr-preflight')
    expect(preflightStep?.if).toBeUndefined()
    expect(policyJob.if).toBeUndefined()
    expect(validateStep?.if).toBe("${{ steps.preflight.outputs.legacy-automated != 'true' }}")

    expect(tokenStep).toMatchObject({
      id: 'app-token',
      if: "${{ steps.preflight.outputs.needs-project == 'true' }}",
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        'client-id': '${{ vars.DSH_ISSUE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.DSH_ISSUE_APP_PRIVATE_KEY }}',
        owner: 'deepseek-harness',
        repositories: 'deepseek-harness',
        'permission-issues': 'read',
        'permission-organization-projects': 'read',
      },
    })
    expect(validateStep).toMatchObject({
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        PROJECT_TOKEN: '${{ steps.app-token.outputs.token }}',
      },
    })
  })
})

describe('npm release workflows', () => {
  it('keeps publication dispatch-only and pack in the PR workflow', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(file === 'release.yml' ? ['dependencies', 'pack'] : ['pack'])
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })

  it('runs dependency policy and npm layout checks in the DSH release workflow', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const dependencies = workflowJob(workflow, 'dependencies')
    if (!isRecord(workflow.on) || !Array.isArray(dependencies.steps)) {
      throw new TypeError('DSH release workflow must define triggers and dependency steps')
    }
    const commands = dependencies.steps.flatMap(step =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [])

    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(commands).toContain('pnpm run verify-package-dependencies')
    expect(commands).toContain('pnpm run verify-npm-install-layout')
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
