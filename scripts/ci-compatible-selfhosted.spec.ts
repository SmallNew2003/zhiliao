import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { BUILD_BACKED_NODE_COMPAT_VERSION } from './run-gates.ts'

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface CompatibilityJob {
  'runs-on': string
  if: string
  env: Record<string, string>
  strategy: { 'fail-fast': boolean; matrix: { include: Array<{ node: string | number; name: string; runner: string; gate_concurrency: string }> } }
  steps: Step[]
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: { 'node-compat': CompatibilityJob }
}
// Python keeps its own required verdict in ci-python.yml.
const pythonWorkflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci-python.yml'), 'utf8')) as {
  jobs: { 'python-sdk': { 'runs-on': string } }
}
const job = workflow.jobs['node-compat']

describe('Node compatibility routing', () => {
  it('runs the build-backed compatibility minor and declares it for installed CLI users', () => {
    expect(job.strategy.matrix.include.filter(entry => String(entry.node) === BUILD_BACKED_NODE_COMPAT_VERSION)).toHaveLength(1)
    for (const manifest of ['package.json', 'apps/cli/package.json']) {
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', manifest), 'utf8')) as { engines: { node: string } }
      expect(pkg.engines.node).toBe(`>=${BUILD_BACKED_NODE_COMPAT_VERSION}.0`)
    }
  })

  it('runs every compatibility leg on a standard hosted runner', () => {
    // The repository carries no enterprise or self-hosted pool, so the lane
    // names a label GitHub schedules for free. A reintroduced pool expression
    // would queue forever on a label no runner answers.
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.if).toBe("github.event_name == 'pull_request'")
    for (const entry of job.strategy.matrix.include) {
      expect(entry.runner).toBe('ubuntu-latest')
    }
  })

  it('preserves the supported version jobs and their concurrency', () => {
    expect(job.if).toBe("github.event_name == 'pull_request'")
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job.strategy.matrix.include).toEqual([
      { node: '24.9', name: 'node 24.9', runner: 'ubuntu-latest', gate_concurrency: '1' },
      { node: 26, name: 'node 26', runner: 'ubuntu-latest', gate_concurrency: '1' },
    ])
    expect(job.env.DSH_GATE_CONCURRENCY).toBe('${{ matrix.gate_concurrency }}')
    expect(job.steps.map(step => step.run)).toContain('pnpm run check:node-compat')
    expect(job.steps.map(step => step.run)).toContain('pnpm exec vitest run packages/boot/app-boot/tests/loader-shape.compat.spec.ts')
    expect(pythonWorkflow.jobs['python-sdk']['runs-on']).toBe('ubuntu-latest')
  })

  it('enables hosted package caching on the hosted runner without runner overrides', () => {
    const setup = job.steps.find(step => step.uses === 'actions/setup-node@v7.0.0')!
    expect(setup.env).toBeUndefined()
    expect(setup.with?.['node-version']).toBe('${{ matrix.node }}')
    expect(setup.with?.cache).toBe('pnpm')
    expect(setup.with?.['package-manager-cache']).toBe(false)
    expect(job.steps[0]?.with).toEqual({ 'persist-credentials': false })
    expect(job.steps.some(step => step.uses?.startsWith('actions/cache/'))).toBe(false)
    expect(job.env).not.toHaveProperty('NODE_OPTIONS')
  })
})
