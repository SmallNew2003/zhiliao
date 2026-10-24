/** Inline visualization copy; model-authored content owns its own labels. */
export const en = {
  preview: 'Preview', source: 'Source', copy: 'Copy', copied: 'Copied', enlarge: 'Enlarge', close: 'Close', reload: 'Reload',
  download: 'Download', downloadSource: 'Download source', downloadHtml: 'Download HTML', downloadSvg: 'Download SVG', downloadPng: 'Download PNG',
  chart: 'Chart', title: 'Visualization', loading: 'Loading visualization', waiting: 'Waiting for a closing fence',
  inactive: 'Preview paused; activating restores its initial state', activate: 'Activate preview',
  invalidMetadata: 'Invalid preview metadata', runtimeUnavailable: 'This preview runtime is unavailable', invalidLibrary: 'Unsupported preview library',
  sourceTooLarge: 'Preview source exceeds the configured limit', failed: 'Visualization failed',
  readinessTimeout: 'Visualization did not become ready in time', navigated: 'Preview left its controlled document',
  exportTooLarge: 'Download exceeds the configured limit', invalidExport: 'Invalid download response', exportTimeout: 'Download response timed out',
  exportPending: 'A download is already pending', copyFailed: 'Could not copy source', downloadFailed: 'Could not download visualization',
} as const

/** Translation keys supplied by the visualization registration. */
export type VisualizationKey = keyof typeof en

/** Chinese controls and local diagnostics. */
export const zh: Record<VisualizationKey, string> = {
  preview: '预览', source: '源码', copy: '复制', copied: '已复制', enlarge: '放大', close: '关闭', reload: '重新加载',
  download: '下载', downloadSource: '下载源码', downloadHtml: '下载 HTML', downloadSvg: '下载 SVG', downloadPng: '下载 PNG',
  chart: '图表', title: '可视化', loading: '正在加载可视化', waiting: '等待代码围栏闭合',
  inactive: '预览已暂停；激活后将恢复初始状态', activate: '激活预览',
  invalidMetadata: '预览元数据无效', runtimeUnavailable: '此预览运行时不可用', invalidLibrary: '不支持此预览库',
  sourceTooLarge: '预览源码超过配置限制', failed: '可视化加载失败',
  readinessTimeout: '可视化未在规定时间内就绪', navigated: '预览已离开受控文档',
  exportTooLarge: '下载内容超过配置限制', invalidExport: '下载响应无效', exportTimeout: '下载响应超时',
  exportPending: '已有下载正在进行', copyFailed: '无法复制源码', downloadFailed: '无法下载可视化',
}
