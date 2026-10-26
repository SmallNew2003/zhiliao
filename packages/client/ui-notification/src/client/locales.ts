/** `settings.notification` namespace dictionaries (the notification row's copy and the announced headlines). */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '系统通知',
  'row.description': '任务需要你时，在系统通知中心提醒',
  'row.enabled': '启用系统通知',
  'row.turnComplete': '会话完成时',
  'row.turnCompleteHint': '会话在后台跑完时提醒',
  'row.awaitingInput': '等待审批或回答时',
  'row.awaitingInputHint': '需要你操作才能继续时提醒',
  'row.error': '出错时',
  'row.errorHint': '会话执行失败时提醒',
  'row.permissionDenied': '系统通知权限已被拒绝，请在系统设置中允许后重试',
  'row.permissionDefault': '首次通知时系统会请求权限',
  'row.permissionGranted': '已获得系统通知权限',
  'row.permissionUnsupported': '当前环境不支持系统通知',
  'notification.turnComplete.one': '会话已完成',
  'notification.turnComplete.many': '{count} 个会话已完成',
  'notification.awaitingInput.one': '会话等待你的操作',
  'notification.awaitingInput.many': '{count} 个会话等待你的操作',
  'notification.error.one': '会话出错了',
  'notification.error.many': '{count} 个会话出错了',
  'notification.body.one': '「{title}」',
  'notification.body.many': '点击查看',
} satisfies Record<string, string>

/** The settings.notification namespace key union. */
export type NotificationKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'System notifications',
  'row.description': 'Get a system notification when a task needs you',
  'row.enabled': 'Enable system notifications',
  'row.turnComplete': 'When a session finishes',
  'row.turnCompleteHint': 'Announce a session that finished in the background',
  'row.awaitingInput': 'When approval or an answer is needed',
  'row.awaitingInputHint': 'Announce a request that blocks the session on you',
  'row.error': 'When something fails',
  'row.errorHint': 'Announce a failed session run',
  'row.permissionDenied': 'System notification permission is denied; allow it in system settings',
  'row.permissionDefault': 'The system asks for permission on the first notification',
  'row.permissionGranted': 'System notification permission is granted',
  'row.permissionUnsupported': 'This environment does not support system notifications',
  'notification.turnComplete.one': 'Session finished',
  'notification.turnComplete.many': '{count} sessions finished',
  'notification.awaitingInput.one': 'A session needs you',
  'notification.awaitingInput.many': '{count} sessions need you',
  'notification.error.one': 'A session failed',
  'notification.error.many': '{count} sessions failed',
  'notification.body.one': '“{title}”',
  'notification.body.many': 'Click to view',
} satisfies Record<NotificationKey, string>
