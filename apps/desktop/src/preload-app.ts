/** Origin-scoped boot, native directory selection, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC, SCHEME, type DesktopNotificationPermission, type DesktopNotificationRequest,
  type DshDesktopProductApi, type DesktopUpdatePresentation,
} from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
  notifications: {
    show: (request: DesktopNotificationRequest) => ipcRenderer.invoke(DESKTOP_IPC.notifyShow, request) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, sessionId: string): void => { listener(sessionId) }
      ipcRenderer.on(DESKTOP_IPC.notifyClicked, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.notifyClicked, handle) }
    },
    permission: () => ipcRenderer.invoke(DESKTOP_IPC.notifyPermission) as Promise<DesktopNotificationPermission>,
  },
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  syncWindowsAppearance()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })
