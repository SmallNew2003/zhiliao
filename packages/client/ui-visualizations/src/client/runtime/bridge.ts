/** Generation-bound, parent-side protocol for an opaque preview document. */
import type { Config } from '../../config.ts'

/** Messages that may update one live preview. */
export type PreviewMessage =
  | { readonly type: 'ready'; readonly title: string; readonly charts: readonly string[] }
  | { readonly type: 'height'; readonly height: number }
  | { readonly type: 'error'; readonly error: string }

/** A validated download response; SVG remains bytes, never application markup. */
export interface ExportResult {
  readonly mime: 'image/svg+xml' | 'image/png'
  readonly data: string
}

type PendingExport = {
  readonly format: 'svg' | 'png'
  readonly resolve: (result: ExportResult) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Validate and decode export bytes without creating application markup.
 * @param result - Frame response after field validation.
 * @param limit - Maximum decoded bytes.
 * @returns Download bytes; malformed MIME/data or excessive bytes throw.
 */
export function exportBytes(result: ExportResult, limit: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>
  if (result.mime === 'image/svg+xml') {
    bytes = new TextEncoder().encode(result.data)
    if (bytes.byteLength > limit) throw new Error('exportTooLarge')
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s/>]/u.test(result.data)) throw new Error('invalidExport')
  } else {
    const prefix = 'data:image/png;base64,'
    if (!result.data.startsWith(prefix) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.data.slice(prefix.length))) throw new Error('invalidExport')
    const encoded = result.data.slice(prefix.length)
    if (Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) > limit) throw new Error('exportTooLarge')
    bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error('invalidExport')
  }
  if (bytes.byteLength > limit) throw new Error('exportTooLarge')
  return bytes
}

/** A port owns its readiness deadline and at most one requested export. */
export class PreviewBridge {
  private disposed = false
  private ready = false
  private failed = false
  private sequence = 0
  private pending: { readonly id: string; readonly value: PendingExport } | undefined
  private readonly readiness: ReturnType<typeof setTimeout>

  /**
   * Attach one private port and start its readiness deadline.
   * @param port - Parent endpoint; no window message dispatcher is installed.
   * @param generation - Unpredictable identity embedded in the trusted bootstrap.
   * @param config - Resolved deadlines, height bounds, and byte limits.
   * @param onMessage - Current preview's presentation callback.
   */
  constructor(
    private readonly port: MessagePort,
    private readonly generation: string,
    private readonly config: Config,
    private readonly onMessage: (message: PreviewMessage) => void,
  ) {
    port.onmessage = (event) => { this.receive(event.data) }
    port.start()
    this.readiness = setTimeout(() => { this.fail('readinessTimeout') }, config.readinessTimeoutMs)
  }

  /**
   * Validate a frame message before changing local presentation or settling a request.
   * @param value - Untrusted structured-clone payload.
   */
  receive(value: unknown): void {
    if (this.disposed || typeof value !== 'object' || value === null) return
    const message = value as Record<string, unknown>
    if (message.generation !== this.generation) return
    switch (message.type) {
      case 'ready':
        if (this.ready || this.failed || typeof message.title !== 'string' || new TextEncoder().encode(message.title).length > 512
          || !Array.isArray(message.charts) || message.charts.length > 64
          || message.charts.some(chart => typeof chart !== 'string' || chart.length > 128)) return
        this.ready = true
        clearTimeout(this.readiness)
        this.onMessage({ type: 'ready', title: message.title, charts: message.charts as string[] })
        return
      case 'height':
        if (this.failed || typeof message.height !== 'number' || !Number.isFinite(message.height)) return
        this.onMessage({ type: 'height', height: Math.max(this.config.minHeight, Math.min(this.config.maxHeight, message.height)) })
        return
      case 'error':
        if (typeof message.error === 'string' && new TextEncoder().encode(message.error).length <= 4096) this.fail(message.error)
        return
      case 'export': {
        const pending = this.pending
        if (pending === undefined || message.requestId !== pending.id) return
        if (typeof message.data !== 'string' || message.mime !== (pending.value.format === 'svg' ? 'image/svg+xml' : 'image/png')) {
          this.rejectExport('invalidExport'); return
        }
        try {
          exportBytes(message as unknown as ExportResult, this.config.maxExportBytes)
        } catch (error) {
          this.rejectExport(error instanceof Error ? error.message : 'invalidExport'); return
        }
        clearTimeout(pending.value.timer)
        this.pending = undefined
        pending.value.resolve({ mime: message.mime as ExportResult['mime'], data: message.data })
        return
      }
      default:
        return // Frame messages cannot request Host operations or other commands.
    }
  }

  /**
   * Send a theme update without replacing authored content.
   * @param theme - Plain public theme values.
   */
  theme(theme: PreviewTheme): void {
    if (!this.disposed) this.port.postMessage({ type: 'theme', generation: this.generation, theme })
  }

  /**
   * Request a single download after a user action.
   * @param format - Diagram SVG or helper-owned chart PNG.
   * @param chart - Chart identity selected by the user.
   * @returns Validated response bytes; teardown, rejection, or timeout reject.
   */
  export(format: 'svg' | 'png', chart?: string): Promise<ExportResult> {
    if (this.disposed || this.failed) return Promise.reject(new Error('disposed'))
    if (this.pending !== undefined) return Promise.reject(new Error('exportPending'))
    const id = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rejectExport('exportTimeout') }, this.config.readinessTimeoutMs)
      this.pending = { id, value: { format, resolve, reject, timer } }
      this.port.postMessage({ type: 'export', generation: this.generation, requestId: id, format, chart })
    })
  }

  /** Retire callbacks, deadlines, and pending exports before releasing the endpoint. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.readiness)
    this.rejectExport('disposed')
    this.port.onmessage = null
    this.port.close()
  }

  private rejectExport(reason: string): void {
    if (this.pending === undefined) return
    clearTimeout(this.pending.value.timer)
    this.pending.value.reject(new Error(reason))
    this.pending = undefined
  }

  private fail(error: string): void {
    if (this.failed || this.disposed) return
    this.failed = true
    clearTimeout(this.readiness)
    this.rejectExport('disposed')
    this.onMessage({ type: 'error', error })
  }
}

/** Public colors and typography transported into the authored document. */
export interface PreviewTheme {
  readonly colorScheme: 'light' | 'dark'
  readonly background: string
  readonly foreground: string
  readonly accent: string
  readonly fontFamily: string
  readonly fontSize: number
}
