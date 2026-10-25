/**
 * Dictionaries for project services UI copy.
 * @module
 */

export const NS = 'projectServices' as const

/** Chinese dictionary. */
export const zh = {
  'title': '项目服务管理',
  'panel': '项目服务',
  'section.worktree': 'Git 工作树',
  'worktree.select': '选择工作树…',
  'worktree.present': '可用',
  'worktree.missing': '目录缺失',
  'section.native': '本地原生服务',
  'section.docker': 'Docker 与 Compose 服务',
  'section.provider': '提供方',
  'kind.native': '原生',
  'kind.docker': 'Docker',
  'empty.native': '当前工作树未检测到原生服务',
  'empty.docker': '当前工作树未检测到 Docker / Compose 服务',
  'action.start': '启动',
  'action.stop': '停止',
  'action.restart': '重启',
  'action.stopAll': '全部停止',
  'action.logs': '查看日志',
  'action.refresh': '刷新',
  'status.running': '运行中',
  'status.stopped': '已停止',
  'status.starting': '启动中',
  'status.unknown': '未知',
  'ownership.managed': '托管',
  'ownership.external': '外部',
  'ports': '端口：',
  'provider.ready': '就绪',
  'provider.stale': '陈旧',
  'provider.unavailable': '不可用',
  'logs.title': '服务日志',
  'logs.empty': '暂无输出日志',
  'logs.loading': '正在加载日志…',
  'logs.truncated': '已达 16 KiB 截断上限',
  'logs.gap': '日志存在缺口，部分输出已丢失',
  'logs.unavailable': '日志不可用：',
  'logs.close': '关闭',
  'error.prefix': '操作失败：',
  'error.dismiss': '关闭提示',
} as const

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'title': 'Project Services',
  'panel': 'Project Services',
  'section.worktree': 'Git Worktree',
  'worktree.select': 'Select worktree…',
  'worktree.present': 'Present',
  'worktree.missing': 'Missing',
  'section.native': 'Local Native Services',
  'section.docker': 'Docker & Compose Services',
  'section.provider': 'Providers',
  'kind.native': 'Native',
  'kind.docker': 'Docker',
  'empty.native': 'No native services detected in current worktree',
  'empty.docker': 'No Docker / Compose services detected in current worktree',
  'action.start': 'Start',
  'action.stop': 'Stop',
  'action.restart': 'Restart',
  'action.stopAll': 'Stop All',
  'action.logs': 'View Logs',
  'action.refresh': 'Refresh',
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'status.starting': 'Starting',
  'status.unknown': 'Unknown',
  'ownership.managed': 'Managed',
  'ownership.external': 'External',
  'ports': 'Ports: ',
  'provider.ready': 'Ready',
  'provider.stale': 'Stale',
  'provider.unavailable': 'Unavailable',
  'logs.title': 'Service Logs',
  'logs.empty': 'No output logs yet',
  'logs.loading': 'Loading logs…',
  'logs.truncated': 'Capped at 16 KiB limit',
  'logs.gap': 'Log gap detected; some output was lost',
  'logs.unavailable': 'Logs unavailable: ',
  'logs.close': 'Close',
  'error.prefix': 'Operation failed: ',
  'error.dismiss': 'Dismiss',
}

/**
 * Key union of this package's copy dictionaries. `zh` is the source of truth and `en` is
 * typed against it, so a key present in one dictionary and absent from the other is a
 * compile error. Components read copy through `t(key)`.
 */
export type ProjectServicesKey = keyof typeof zh
