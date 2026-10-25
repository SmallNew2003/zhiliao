// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ApiServiceCheckoutView,
  ApiServiceGroupView,
  ApiServiceInventoryView,
  ApiServiceItemView,
  ApiServiceLogsView,
  ApiServiceProviderView,
} from '@deepseek-ai/dsh-api-project-services-controller/types'
import { ProjectServicesPanel } from '../src/client/ProjectServicesPanel.tsx'
import type { ProjectServicesPanelProps, ProjectServicesPanelSnapshot } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh)

function checkout(overrides: Partial<ApiServiceCheckoutView> = {}): ApiServiceCheckoutView {
  return { id: 'main', path: '/repos/my-project', availability: 'present', ...overrides }
}

function item(overrides: Partial<ApiServiceItemView> = {}): ApiServiceItemView {
  return {
    id: 'native:web',
    providerId: 'native',
    projectId: 'proj-1',
    checkoutId: 'main',
    revision: '7',
    name: 'web-server',
    kind: 'native',
    state: 'running',
    ownership: 'managed',
    actions: ['start', 'stop', 'restart'],
    ports: [3000],
    ...overrides,
  }
}

function group(overrides: Partial<ApiServiceGroupView> = {}): ApiServiceGroupView {
  return { id: 'group:stack', name: 'docker-compose.yml', checkoutId: 'main', revision: '3', targetIds: ['docker:postgres'], ...overrides }
}

function provider(overrides: Partial<ApiServiceProviderView> = {}): ApiServiceProviderView {
  return { id: 'native', kind: 'native', state: 'ready', observedAt: 1000, ...overrides }
}

function inventory(overrides: Partial<ApiServiceInventoryView> = {}): ApiServiceInventoryView {
  return {
    project: { id: 'proj-1', path: '/repos/my-project' },
    checkouts: [checkout()],
    items: [],
    groups: [],
    providers: [],
    revision: '1',
    ...overrides,
  }
}

function logs(overrides: Partial<ApiServiceLogsView> = {}): ApiServiceLogsView {
  return { chunks: [], truncated: false, gap: false, ...overrides }
}

/** Everything the panel's verbs can be asked to do; each is a spy. */
function verbs() {
  return {
    selectCheckout: vi.fn(),
    refresh: vi.fn(),
    control: vi.fn(() => Promise.resolve()),
    stopGroup: vi.fn(() => Promise.resolve()),
    openLogs: vi.fn(),
    closeLogs: vi.fn(),
    dismissError: vi.fn(),
  }
}

function renderPanel(
  snapshot: Partial<ProjectServicesPanelSnapshot> = {},
  overrides: Partial<ProjectServicesPanelProps> = {},
) {
  const store: SnapshotStore<ProjectServicesPanelSnapshot> = createSnapshotStore<ProjectServicesPanelSnapshot>({
    inventory: undefined,
    selectedCheckoutId: undefined,
    logsTargetId: undefined,
    logs: undefined,
    isLoadingLogs: false,
    pendingActions: {},
    error: undefined,
    ...snapshot,
  })
  const props = {
    t,
    ...verbs(),
    usePanel: bindSnapshotSelector(store),
  } as unknown as ProjectServicesPanelProps
  const view = render(<ProjectServicesPanel {...props} {...overrides} />)
  return {
    store,
    set: (next: Partial<ProjectServicesPanelSnapshot>) => {
      act(() => { store.set({ ...store.getSnapshot(), ...next }) })
    },
    ...view,
  }
}

describe('ProjectServicesPanel', () => {
  it('renders the title, the selected checkout tag, and the worktree selector', () => {
    const onSelectCheckout = vi.fn()
    renderPanel({
      inventory: inventory({
        checkouts: [checkout(), checkout({ id: 'feat-service', path: '/worktrees/feat-service' })],
      }),
      selectedCheckoutId: 'main',
    }, { selectCheckout: onSelectCheckout })

    expect((screen.getByRole('heading', { level: 2 })).textContent).toContain('项目服务管理')
    expect(screen.getByText('可用')).toBeTruthy()

    const select = screen.getByTestId('worktree-selector') as HTMLSelectElement
    expect(select.value).toBe('main')
    expect(select.options).toHaveLength(2)
    expect(select.options[1]?.textContent).toContain('feat-service (/worktrees/feat-service)')

    fireEvent.change(select, { target: { value: 'feat-service' } })
    expect(onSelectCheckout).toHaveBeenCalledWith('feat-service')
  })

  it('follows the first checkout when the source names none, and marks a missing directory', () => {
    const { unmount } = renderPanel({
      inventory: inventory({
        checkouts: [checkout({ availability: 'missing' }), checkout({ id: 'other', path: '/repos/other' })],
      }),
    })

    const select = screen.getByTestId('worktree-selector') as HTMLSelectElement
    expect(select.value).toBe('main')
    expect(screen.getByText('目录缺失')).toBeTruthy()
    unmount()

    // No checkout at all: the selector offers the placeholder instead of an empty list.
    renderPanel({ inventory: inventory({ checkouts: [] }) })
    const empty = screen.getByTestId('worktree-selector') as HTMLSelectElement
    expect(empty.value).toBe('')
    expect(empty.options).toHaveLength(1)
    expect(screen.getByText('选择工作树…')).toBeTruthy()
  })

  it('renders no checkout tag when the selected checkout left the inventory', () => {
    renderPanel({
      inventory: inventory({ checkouts: [checkout({ id: 'other', path: '/repos/other' })] }),
      selectedCheckoutId: 'gone',
    })
    expect(screen.queryByText('可用')).toBeNull()
    expect(screen.queryByText('目录缺失')).toBeNull()
  })

  it('renders a provider row per provider and no row when the Host reports none', () => {
    const { unmount } = renderPanel({
      inventory: inventory({
        providers: [
          provider(),
          provider({ id: 'docker', kind: 'docker', state: 'stale', reason: 'daemon unreachable' }),
          provider({ id: 'llm', kind: 'native', state: 'unavailable' }),
          provider({ id: 'cache', kind: 'native', state: 'degraded' }),
        ],
      }),
    })

    expect(screen.getByText('提供方')).toBeTruthy()
    expect(screen.getByText('就绪')).toBeTruthy()
    expect(screen.getByText('陈旧')).toBeTruthy()
    // An unrecognised provider state reads as unavailable rather than as a healthy one.
    expect(screen.getAllByText('不可用')).toHaveLength(2)
    expect(screen.getAllByText('原生')).toHaveLength(3)
    expect(screen.getByText('Docker')).toBeTruthy()
    unmount()

    renderPanel({ inventory: inventory() })
    expect(screen.queryByTestId('provider-row')).toBeNull()
  })

  it('renders the failure banner and dismisses it', () => {
    const onDismissError = vi.fn()
    renderPanel({ error: 'port 3000 already in use' }, { dismissError: onDismissError })

    const banner = screen.getByTestId('error-banner')
    expect((banner).textContent).toContain('操作失败：port 3000 already in use')
    fireEvent.click(screen.getByText('关闭提示'))
    expect(onDismissError).toHaveBeenCalledTimes(1)
  })

  it('renders the native empty notice, then the cards with their state, ownership, stale, ports and detail', () => {
    const { set } = renderPanel({ inventory: inventory({ checkouts: [checkout()] }) })
    expect(screen.getByText('当前工作树未检测到原生服务')).toBeTruthy()

    set({
      inventory: inventory({
        items: [
          item(),
          item({ id: 'native:worker', name: 'background-worker', state: 'stopped', ownership: 'external', ports: [], detail: 'pid 4242' }),
          item({ id: 'native:boot', name: 'boot-service', state: 'starting', stale: true }),
          item({ id: 'native:gone', name: 'gone-service', state: 'unknown', actions: [] }),
        ],
      }),
    })

    expect(screen.queryByText('当前工作树未检测到原生服务')).toBeNull()
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.getByText('已停止')).toBeTruthy()
    expect(screen.getByText('启动中')).toBeTruthy()
    expect(screen.getByText('未知')).toBeTruthy()
    expect(screen.getAllByText('托管')).toHaveLength(3)
    expect(screen.getByText('外部')).toBeTruthy()
    expect(screen.getByText('陈旧')).toBeTruthy()
    expect(screen.getByText('pid 4242')).toBeTruthy()
    expect(screen.getByTestId('service-item-native:web').textContent).toContain('端口：3000')
    // A card that reports no port renders no port line at all.
    expect(screen.getByTestId('service-item-native:worker').textContent).not.toContain('端口：')
    // A running service with a start verb offered keeps only stop and restart.
    expect(screen.queryByTestId('action-start-native:web')).toBeNull()
    expect(screen.getByTestId('action-stop-native:web')).toBeTruthy()
    expect(screen.getByTestId('action-restart-native:web')).toBeTruthy()
    // A stopped service offers start; a service with no verbs offers only logs.
    expect(screen.getByTestId('action-start-native:worker')).toBeTruthy()
    expect(screen.queryByTestId('action-stop-native:worker')).toBeNull()
    expect(screen.queryByTestId('action-restart-native:worker')).toBeNull()
    expect(screen.queryByTestId('action-start-native:gone')).toBeNull()
    expect(screen.queryByTestId('action-stop-native:gone')).toBeNull()
    expect(screen.queryByTestId('action-restart-native:gone')).toBeNull()
    expect(screen.getByTestId('action-logs-native:gone')).toBeTruthy()
  })

  it('disables a card whose action is in flight and runs the verbs with the observed revision', async () => {
    const onControl = vi.fn(() => Promise.resolve())
    const onOpenLogs = vi.fn()
    const onRefresh = vi.fn()
    const { set } = renderPanel({
      inventory: inventory({ items: [item(), item({ id: 'native:worker', name: 'background-worker', state: 'stopped' })] }),
    }, { control: onControl, openLogs: onOpenLogs, refresh: onRefresh })

    fireEvent.click(screen.getByTestId('action-stop-native:web'))
    expect(onControl).toHaveBeenCalledWith('stop', 'native:web', '7')

    fireEvent.click(screen.getByTestId('action-restart-native:web'))
    expect(onControl).toHaveBeenCalledWith('restart', 'native:web', '7')

    fireEvent.click(screen.getByTestId('action-start-native:worker'))
    expect(onControl).toHaveBeenCalledWith('start', 'native:worker', '7')

    fireEvent.click(screen.getByTestId('action-logs-native:web'))
    expect(onOpenLogs).toHaveBeenCalledWith('native:web')

    fireEvent.click(screen.getByTestId('refresh-button'))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    set({ pendingActions: { 'native:worker': 'start' } })
    expect(screen.getByTestId('action-start-native:worker')).toHaveProperty('disabled', true)
  })

  it('filters services by the selected checkout and switches the whole panel', () => {
    const { set } = renderPanel({
      inventory: inventory({
        checkouts: [checkout(), checkout({ id: 'feat-service', path: '/worktrees/feat-service' })],
        items: [item(), item({ id: 'native:feat', checkoutId: 'feat-service', name: 'feature-api', state: 'stopped' })],
      }),
      selectedCheckoutId: 'main',
    })
    expect(screen.getByText('web-server')).toBeTruthy()
    expect(screen.queryByText('feature-api')).toBeNull()

    set({ selectedCheckoutId: 'feat-service' })
    expect(screen.getByText('feature-api')).toBeTruthy()
    expect(screen.queryByText('web-server')).toBeNull()
    expect(screen.getByText('当前工作树未检测到 Docker / Compose 服务')).toBeTruthy()
  })

  it('renders the inline log viewer with its loading, empty, chunked, truncated, gap and unavailable states', () => {
    const onCloseLogs = vi.fn()
    const { set } = renderPanel({
      inventory: inventory({ items: [item()] }),
      logsTargetId: 'native:web',
      isLoadingLogs: true,
    }, { closeLogs: onCloseLogs })

    expect(screen.getByTestId('logs-viewer-native:web')).toBeTruthy()
    expect(screen.getByText('正在加载日志…')).toBeTruthy()

    set({ isLoadingLogs: false, logs: logs() })
    expect(screen.getByText('暂无输出日志')).toBeTruthy()

    set({
      logs: logs({
        chunks: [
          { targetId: 'native:web', stream: 'stdout', text: 'listening on :3000' },
          { targetId: 'native:web', stream: 'stderr', text: 'deprecation warning' },
        ],
        truncated: true,
        gap: true,
        unavailable: 'daemon restarted',
      }),
    })
    expect(screen.getByText('listening on :3000')).toBeTruthy()
    expect(screen.getByText('deprecation warning')).toBeTruthy()
    expect(screen.getByText('已达 16 KiB 截断上限')).toBeTruthy()
    expect((screen.getByTestId('logs-gap-native:web')).textContent).toContain('日志存在缺口，部分输出已丢失')
    expect((screen.getByTestId('logs-unavailable-native:web')).textContent).toContain('日志不可用：daemon restarted')
    // stderr is tinted by the stylesheet, not by an inline colour.
    const body = screen.getByTestId('logs-body-native:web')
    const lines = [...body.children]
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.getAttribute('style')).toBeNull()

    fireEvent.click(screen.getByTestId('logs-close'))
    expect(onCloseLogs).toHaveBeenCalledTimes(1)
  })

  it('renders no log viewer for a service the source did not open', () => {
    renderPanel({ inventory: inventory({ items: [item()] }), logsTargetId: 'native:other' })
    expect(screen.queryByTestId('logs-viewer-native:web')).toBeNull()
  })

  it('renders a Compose group with its stop-all control and its member cards', () => {
    const onStopGroup = vi.fn(() => Promise.resolve())
    const onControl = vi.fn(() => Promise.resolve())
    const onOpenLogs = vi.fn()
    const { set } = renderPanel({
      inventory: inventory({
        items: [
          item({ id: 'docker:postgres', kind: 'docker', name: 'db', revision: '11', ports: [5432], stale: true }),
          item({ id: 'docker:redis', kind: 'docker', name: 'cache', revision: '12', detail: 'container 9f2c' }),
        ],
        groups: [group({ targetIds: ['docker:postgres', 'docker:redis'] })],
      }),
    }, { stopGroup: onStopGroup, control: onControl, openLogs: onOpenLogs })

    expect(screen.getByTestId('group-card-group:stack')).toBeTruthy()
    expect(screen.getByText('docker-compose.yml')).toBeTruthy()
    expect(screen.getByText('container 9f2c')).toBeTruthy()
    expect(screen.getAllByText('陈旧')).toHaveLength(1)
    const stopAll = screen.getByTestId('action-stop-all-group:stack')
    expect(stopAll).toHaveProperty('disabled', false)

    fireEvent.click(stopAll)
    expect(onStopGroup).toHaveBeenCalledWith([
      { targetId: 'docker:postgres', expectedRevision: '11' },
      { targetId: 'docker:redis', expectedRevision: '12' },
    ])

    set({ pendingActions: { 'docker:postgres': 'stop' } })
    expect(screen.getByTestId('action-stop-all-group:stack')).toHaveProperty('disabled', true)

    set({ pendingActions: {} })
    expect(screen.getByTestId('action-stop-all-group:stack')).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByTestId('action-logs-docker:redis'))
    expect(onOpenLogs).toHaveBeenCalledWith('docker:redis')

    // A stopped member offers start; the running one keeps stop and restart.
    set({
      inventory: inventory({
        items: [
          item({ id: 'docker:postgres', kind: 'docker', name: 'db', state: 'stopped', revision: '11' }),
          item({ id: 'docker:redis', kind: 'docker', name: 'cache', revision: '12' }),
        ],
        groups: [group({ targetIds: ['docker:postgres', 'docker:redis'] })],
      }),
    })
    expect(screen.getByTestId('action-start-docker:postgres')).toBeTruthy()
    expect(screen.queryByTestId('action-stop-docker:postgres')).toBeNull()
    expect(screen.getByTestId('action-stop-docker:redis')).toBeTruthy()
    fireEvent.click(screen.getByTestId('action-start-docker:postgres'))
    expect(onControl).toHaveBeenCalledWith('start', 'docker:postgres', '11')
    fireEvent.click(screen.getByTestId('action-stop-docker:redis'))
    expect(onControl).toHaveBeenCalledWith('stop', 'docker:redis', '12')
    fireEvent.click(screen.getByTestId('action-restart-docker:redis'))
    expect(onControl).toHaveBeenCalledWith('restart', 'docker:redis', '12')
    expect(onStopGroup).toHaveBeenCalledTimes(1)
  })

  it('hides a group stop-all control while no member runs', () => {
    renderPanel({
      inventory: inventory({
        items: [item({ id: 'docker:postgres', kind: 'docker', name: 'db', state: 'stopped', revision: '11' })],
        groups: [group({ targetIds: ['docker:postgres'] })],
      }),
    })
    expect(screen.queryByTestId('action-stop-all-group:stack')).toBeNull()
  })

  it('renders ungrouped Docker services beside the groups, and the Docker empty notice', () => {
    const onControl = vi.fn(() => Promise.resolve())
    const onOpenLogs = vi.fn()
    const { unmount } = renderPanel({
      inventory: inventory({
        items: [
          item({ id: 'docker:postgres', kind: 'docker', name: 'db', revision: '11' }),
          item({ id: 'docker:redis', kind: 'docker', name: 'cache', revision: '12', stale: true }),
          item({ id: 'docker:mail', kind: 'docker', name: 'mail', state: 'stopped', revision: '13', detail: 'compose project app' }),
        ],
        groups: [group({ targetIds: ['docker:postgres'] })],
      }),
    }, { control: onControl, openLogs: onOpenLogs })

    expect(screen.getByTestId('service-item-docker:postgres')).toBeTruthy()
    expect(screen.getByTestId('service-item-docker:redis')).toBeTruthy()
    expect(screen.getByTestId('action-stop-docker:redis')).toBeTruthy()
    expect(screen.getByText('compose project app')).toBeTruthy()
    expect(screen.queryByText('当前工作树未检测到 Docker / Compose 服务')).toBeNull()

    fireEvent.click(screen.getByTestId('action-start-docker:mail'))
    expect(onControl).toHaveBeenCalledWith('start', 'docker:mail', '13')
    fireEvent.click(screen.getByTestId('action-stop-docker:redis'))
    expect(onControl).toHaveBeenCalledWith('stop', 'docker:redis', '12')
    fireEvent.click(screen.getByTestId('action-restart-docker:redis'))
    expect(onControl).toHaveBeenCalledWith('restart', 'docker:redis', '12')
    fireEvent.click(screen.getByTestId('action-logs-docker:redis'))
    expect(onOpenLogs).toHaveBeenCalledWith('docker:redis')
    fireEvent.click(screen.getByTestId('action-logs-docker:mail'))
    expect(onOpenLogs).toHaveBeenCalledWith('docker:mail')
    unmount()

    renderPanel({ inventory: inventory({ items: [item()] }) })
    expect(screen.getByText('当前工作树未检测到 Docker / Compose 服务')).toBeTruthy()
  })
})
