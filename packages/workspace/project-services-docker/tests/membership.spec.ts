import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceCheckout,
  ServiceCheckoutId,
  ServiceExecutionIdentity,
  ServiceProjectId,
  ServiceProviderContext,
  ServiceProviderId,
  ServiceRevision,
  ServiceTargetId,
} from '@deepseek-ai/dsh-project-services'
import { resolveDockerMemberships } from '../src/membership.ts'
import type { DockerContainerInspect } from '../src/transport.ts'

const projectId = brandString<ServiceProjectId>('proj-1')
const checkout1 = brandString<ServiceCheckoutId>('chk-1')
const checkout2 = brandString<ServiceCheckoutId>('chk-2')
const providerId = brandString<ServiceProviderId>('docker')

const checkouts: ServiceCheckout[] = [
  { id: checkout1, projectId, path: '/workspace/main', availability: 'present' },
  { id: checkout2, projectId, path: '/workspace/main/packages/sub', availability: 'present' },
]

const context: ServiceProviderContext = {
  project: { id: projectId, path: '/workspace/main', executionIdentity: brandString<ServiceExecutionIdentity>('local') },
  checkouts,
  definitions: [],
  associations: [],
}

function mockContainer(partial: Partial<DockerContainerInspect>): DockerContainerInspect {
  return {
    Id: 'c1234567890abcdef',
    State: {
      Status: 'running',
      Running: true,
      Restarting: false,
      StartedAt: '2026-10-10T00:00:00Z',
      FinishedAt: '',
    },
    Name: '/my-redis',
    RestartCount: 0,
    Config: {
      Image: 'redis:latest',
      Labels: {},
    },
    NetworkSettings: {
      Ports: {},
    },
    Mounts: [],
    ...partial,
  }
}

describe('resolveDockerMemberships', () => {
  it('associates container with checkout using compose working_dir', () => {
    const container = mockContainer({
      Id: 'c1',
      Config: {
        Image: 'nginx',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.service': 'web',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('docker:container:c1')
    expect(items[0]!.checkoutId).toBe(checkout1)
    expect(items[0]!.name).toBe('web')
    expect(items[0]!.state).toBe('running')
    expect(items[0]!.actions).toEqual(['stop', 'restart'])
  })

  it('selects the most specific checkout for nested paths', () => {
    const container = mockContainer({
      Id: 'c2',
      Config: {
        Image: 'node',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main/packages/sub',
          'com.docker.compose.service': 'subservice',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(1)
    expect(items[0]!.checkoutId).toBe(checkout2)
  })

  it('associates container via bind mount source path', () => {
    const container = mockContainer({
      Id: 'c3',
      Name: '/db',
      Mounts: [{ Type: 'bind', Source: '/workspace/main/data' }],
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(1)
    expect(items[0]!.checkoutId).toBe(checkout1)
    expect(items[0]!.name).toBe('db')
  })

  it('excludes one-off containers created by compose run', () => {
    const container = mockContainer({
      Id: 'c4',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.oneoff': 'True',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(0)
  })

  it('excludes containers with no matching checkout or association', () => {
    const container = mockContainer({
      Id: 'c5',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/some/other/project',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(0)
  })

  it('extracts published Host ports and excludes exposed-only ports', () => {
    const container = mockContainer({
      Id: 'c6',
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
      NetworkSettings: {
        Ports: {
          '80/tcp': [{ HostPort: '8080' }],
          '443/tcp': null, // exposed only, not bound to host
          '8080/tcp': [{ HostPort: '8443' }],
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items[0]!.ports).toEqual([8080, 8443])
  })

  it('groups Compose services and creates composite group revisions', () => {
    const c1 = mockContainer({
      Id: 'rep-1',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.project': 'myproject',
          'com.docker.compose.service': 'worker',
        },
      },
    })
    const c2 = mockContainer({
      Id: 'rep-2',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.project': 'myproject',
          'com.docker.compose.service': 'worker',
        },
      },
    })

    const { items, groups } = resolveDockerMemberships([c1, c2], context, providerId)
    expect(items).toHaveLength(2)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.id).toBe(`docker:group:${checkout1}:myproject:worker`)
    expect(groups[0]!.name).toBe('worker')
    expect(groups[0]!.checkoutId).toBe(checkout1)
    expect(groups[0]!.targetIds).toEqual(['docker:container:rep-1', 'docker:container:rep-2'])
  })

  it('separates Compose groups of two worktrees running the same project and service', () => {
    const main = mockContainer({
      Id: 'main-worker',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.project': 'myproject',
          'com.docker.compose.service': 'worker',
        },
      },
    })
    const sub = mockContainer({
      Id: 'sub-worker',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main/packages/sub',
          'com.docker.compose.project': 'myproject',
          'com.docker.compose.service': 'worker',
        },
      },
    })

    const { items, groups } = resolveDockerMemberships([main, sub], context, providerId)
    expect(items).toHaveLength(2)
    expect(groups).toHaveLength(2)
    const ids = groups.map(group => group.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([
      `docker:group:${checkout1}:myproject:worker`,
      `docker:group:${checkout2}:myproject:worker`,
    ])
  })

  it('reports no actions and unknown state for a dead container', () => {
    const container = mockContainer({
      Id: 'c-dead',
      State: {
        Status: 'dead',
        Running: false,
        Restarting: false,
        StartedAt: '',
        FinishedAt: '',
      },
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items[0]!.state).toBe('unknown')
    expect(items[0]!.actions).toEqual([])
  })

  it('reports a restarting container as starting and a paused container as stopped', () => {
    const restarting = mockContainer({
      Id: 'c-restarting',
      State: {
        Status: 'restarting',
        Running: false,
        Restarting: true,
        StartedAt: '',
        FinishedAt: '',
      },
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
    })
    const paused = mockContainer({
      Id: 'c-paused',
      State: {
        Status: 'paused',
        Running: false,
        Restarting: false,
        StartedAt: '',
        FinishedAt: '',
      },
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
    })

    const { items } = resolveDockerMemberships([restarting, paused], context, providerId)
    expect(items[0]!.state).toBe('starting')
    expect(items[1]!.state).toBe('stopped')
  })

  it('ignores published ports that are not positive integers', () => {
    const container = mockContainer({
      Id: 'c-ports',
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
      NetworkSettings: {
        Ports: {
          '80/tcp': [{ HostPort: 'not-a-port' }, { HostPort: '0' }, { HostPort: '8080' }],
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items[0]!.ports).toEqual([8080])
  })

  it('associates a container through a compose config_files directory', () => {
    const container = mockContainer({
      Id: 'c-config',
      Config: {
        Image: 'nginx',
        Labels: {
          'com.docker.compose.project.config_files': '/workspace/main/packages/sub/compose.yaml,,/other/compose.yaml',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(1)
    expect(items[0]!.checkoutId).toBe(checkout2)
  })

  it('associates a saved target with its checkout as managed ownership', () => {
    const container = mockContainer({
      Id: 'c-managed',
      Config: {
        Image: 'app',
        Labels: {},
      },
    })
    const withAssociation: ServiceProviderContext = {
      ...context,
      associations: [{
        id: 'docker:container:c-managed' as ServiceTargetId,
        projectId,
        checkoutId: checkout1,
        providerId,
        revision: brandString<ServiceRevision>('rev-managed'),
      }],
    }

    const { items } = resolveDockerMemberships([container], withAssociation, providerId)
    expect(items).toHaveLength(1)
    expect(items[0]!.checkoutId).toBe(checkout1)
    expect(items[0]!.ownership).toBe('managed')
  })

  it('prefers the most specific checkout when a shorter one matches first', () => {
    const container = mockContainer({
      Id: 'c-nested',
      Config: {
        Image: 'node',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main/packages/sub' },
      },
      Mounts: [{ Type: 'bind', Source: '/workspace/main' }],
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items[0]!.checkoutId).toBe(checkout2)
  })

  it('excludes a bind mount without a source and a volume mount', () => {
    const container = mockContainer({
      Id: 'c-mounts',
      Config: {
        Image: 'nginx',
        Labels: {},
      },
      Mounts: [
        { Type: 'bind', Source: '' },
        { Type: 'volume', Source: '/var/lib/docker/volumes/data/_data' },
      ],
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toEqual([])
  })

  it('excludes one-off containers marked with the lowercase label value', () => {
    const container = mockContainer({
      Id: 'c-oneoff',
      Config: {
        Image: 'app',
        Labels: {
          'com.docker.compose.project.working_dir': '/workspace/main',
          'com.docker.compose.oneoff': 'true',
        },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items).toHaveLength(0)
  })

  it('extracts health state into detail string when present', () => {
    const container = mockContainer({
      Id: 'c7',
      State: {
        Status: 'running',
        Running: true,
        Restarting: false,
        StartedAt: '',
        FinishedAt: '',
        Health: { Status: 'healthy' },
      },
      Config: {
        Image: 'nginx',
        Labels: { 'com.docker.compose.project.working_dir': '/workspace/main' },
      },
    })

    const { items } = resolveDockerMemberships([container], context, providerId)
    expect(items[0]!.detail).toContain('health: healthy')
  })
})
