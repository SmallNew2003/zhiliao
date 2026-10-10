/** One assistant-owned preview; toolbar modes never relocate its iframe. */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Config } from '../config.ts'
import type { ParsedPreview } from './protocol.ts'
import type { VisualizationKey } from './locales.ts'
import type { RuntimeAssets } from './runtime/assets.ts'
import { loadRuntimeAssets } from './runtime/assets.ts'
import { createPreviewDocument, createStandaloneDocument } from './runtime/document.ts'
import { PreviewBridge, exportBytes } from './runtime/bridge.ts'
import type { PreviewTheme } from './runtime/bridge.ts'
import css from './Preview.module.css'

/** Plain registration callbacks and framework-bound observable sources. */
export interface PreviewInjected {
  readonly config: Config
  readonly enter: (id: string) => void
  readonly leave: (id: string) => void
  readonly activate: (id: string) => void
  readonly filename: (title: string, extension: string) => string
  readonly download: (bytes: Uint8Array<ArrayBuffer>, mime: string, filename: string) => void
  readonly hooks: {
    readonly budget: ObservableSnapshot<readonly string[]>
    readonly theme: ObservableSnapshot<PreviewTheme>
  }
}

/** The assistant chain supplies source and routing; the framework binds live facts. */
export type PreviewProps = PropsRuntime<'conversation.chat.codeBlock'>
  & { readonly matched: ParsedPreview }
  & InjectFace<PreviewInjected>
  & PropsLocale<'visualizations'>

/**
 * Render a local diagnostic, inert source, or one active sandbox document.
 * @param props - Derived slot props and registration-owned runtime limits.
 * @returns Localized preview controls and readable source.
 */
export function Preview(props: PreviewProps): ReactNode {
  const { block, matched, config, t, enter, leave, activate, download, filename } = props
  const id = useId()
  const active = props.useBudget(values => values.includes(id))
  const theme = props.useTheme(value => value)
  const root = useRef<HTMLDialogElement>(null)
  const bridge = useRef<PreviewBridge>()
  const opener = useRef<HTMLElement | null>(null)
  const lifecycle = useRef(0)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [enlarged, setEnlarged] = useState(false)
  const [reload, setReload] = useState(0)
  const [frame, setFrame] = useState<{ html: string; generation: string; assets: RuntimeAssets }>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState<string>()
  const [title, setTitle] = useState('')
  const [height, setHeight] = useState(config.minHeight)
  const [charts, setCharts] = useState<readonly string[]>([])
  const [chart, setChart] = useState('1')
  const [copyLabel, setCopyLabel] = useState(false)
  const [exporting, setExporting] = useState(false)
  const language = matched.kind === 'valid' ? matched.language : undefined
  const libraries = matched.kind === 'valid' ? matched.libraries.join(',') : ''
  const closed = matched.kind === 'valid' && matched.closed
  const latestEnlarged = useRef(enlarged)
  latestEnlarged.current = enlarged
  const latestTheme = useRef(theme)
  latestTheme.current = theme

  useEffect(() => {
    if (!closed) return
    const element = (root.current as HTMLDialogElement)
    if (typeof IntersectionObserver === 'undefined') { enter(id); return () => { leave(id) } }
    let retired = false
    const observer = new IntersectionObserver((entries) => {
      if (retired) return
      if (entries.some(entry => entry.isIntersecting)) enter(id)
      else if (!latestEnlarged.current) leave(id)
    })
    observer.observe(element)
    return () => { retired = true; observer.disconnect(); leave(id) }
  }, [id, closed, enter, leave])

  useEffect(() => {
    ++lifecycle.current
    let retired = false
    bridge.current?.dispose(); bridge.current = undefined
    setFrame(undefined); setError(undefined); setCharts([]); setExporting(false); setStatus('loading')
    if (!active || !closed || language === undefined) return
    void loadRuntimeAssets(language, libraries === 'echarts' ? ['echarts'] : []).then((assets) => {
      if (retired) return
      const generation = randomUUID()
      const html = createPreviewDocument({ source: block.code, language, assets, theme: latestTheme.current, generation })
      setFrame({ html, generation, assets })
    }, () => { if (!retired) { setStatus('failed'); setError(t('failed')) } })
    return () => {
      retired = true
      ++lifecycle.current
      bridge.current?.dispose(); bridge.current = undefined
    }
  }, [active, closed, language, libraries, block.code, reload, config])

  useEffect(() => { bridge.current?.theme(theme) }, [theme])
  useEffect(() => {
    if (!enlarged) return
    const dialog = root.current as HTMLDialogElement
    dialog.close()
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { dialog.close(); dialog.open = true }
  }, [enlarged])

  const onLoad = (runtimeDocument: NonNullable<typeof frame>, target: Window): void => {
    if (bridge.current !== undefined) {
      bridge.current.dispose(); bridge.current = undefined
      setFrame(undefined); setStatus('failed'); setError(t('navigated')); return
    }
    const channel = new MessageChannel()
    bridge.current = new PreviewBridge(channel.port1, runtimeDocument.generation, config, (message) => {
      switch (message.type) {
        case 'height': setHeight(message.height); return
        case 'ready': setStatus('ready'); setTitle(message.title); setCharts(message.charts); bridge.current?.theme(latestTheme.current); return
        case 'escape': if (latestEnlarged.current) close(); return
        case 'error':
          setStatus('failed'); setError(message.error === 'readinessTimeout' ? t('readinessTimeout') : `${t('failed')}: ${message.error}`)
          bridge.current?.dispose(); bridge.current = undefined; setFrame(undefined); return
      }
    })
    target.postMessage({ type: 'dsh-preview-init', generation: runtimeDocument.generation }, '*', [channel.port2])
  }
  const close = (): void => { setEnlarged(false); opener.current?.focus() }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(block.code); setCopyLabel(true) }
    catch { setError(t('copyFailed')) }
  }
  const save = async (kind: 'source' | 'html' | 'svg' | 'png'): Promise<void> => {
    const owner = lifecycle.current
    setExporting(true)
    try {
      if (kind === 'source') {
        download(new TextEncoder().encode(block.code), 'text/plain', filename(title || t('title'), language === 'html' ? 'html' : 'mmd'))
      } else if (kind === 'html') {
        const html = createStandaloneDocument({ source: block.code, language: 'html', assets: (frame as NonNullable<typeof frame>).assets, theme: latestTheme.current })
        download(new TextEncoder().encode(html), 'text/html', filename(title || t('title'), 'html'))
      } else {
        const response = await (bridge.current as PreviewBridge).export(kind, kind === 'png' ? chart : undefined)
        if (owner === lifecycle.current) download(exportBytes(response, config.maxExportBytes), response.mime, filename(title || t('title'), kind))
      }
    } catch (error) {
      if (owner === lifecycle.current) {
        const key = error instanceof Error ? error.message : ''
        setError(['exportTooLarge', 'invalidExport', 'exportTimeout', 'exportPending'].includes(key) ? t(key as VisualizationKey) : t('downloadFailed'))
      }
    } finally { if (owner === lifecycle.current) setExporting(false) }
  }
  const diagnostic = matched.kind === 'error' ? t(matched.error) : undefined
  const showSource = mode === 'source' || diagnostic !== undefined || !closed || status === 'failed'
  return <dialog open ref={root} className={`${css.preview} ${enlarged ? css.enlarged : ''}`} data-visualization role={enlarged ? 'dialog' : 'region'} aria-modal={enlarged || undefined} aria-label={title || t('title')} onCancel={(event) => { event.preventDefault(); close() }}>
    <div className={css.toolbar}>
      <button type="button" aria-pressed={mode === 'preview'} onClick={() => { setMode('preview') }}>{t('preview')}</button>
      <button type="button" aria-pressed={mode === 'source'} onClick={() => { setMode('source') }}>{t('source')}</button>
      <button type="button" onClick={() => { void copy() }}>{t(copyLabel ? 'copied' : 'copy')}</button>
      <button type="button" onClick={(event) => { if (enlarged) close(); else { opener.current = event.currentTarget; setEnlarged(true) } }}>{t(enlarged ? 'close' : 'enlarge')}</button>
      {closed && <button type="button" onClick={() => { activate(id); setReload(value => value + 1) }}>{t('reload')}</button>}
      <button type="button" onClick={() => { void save('source') }}>{t('downloadSource')}</button>
      {language === 'html' && closed && <button type="button" disabled={frame === undefined || exporting} onClick={() => { void save('html') }}>{t('downloadHtml')}</button>}
      {language === 'mermaid' && closed && <button type="button" disabled={status !== 'ready' || exporting} onClick={() => { void save('svg') }}>{t('downloadSvg')}</button>}
      {charts.length > 1 && <select aria-label={t('chart')} value={chart} onChange={(event) => { setChart(event.target.value) }}>{charts.map(value => <option key={value} value={value}>{t('chart')} {value}</option>)}</select>}
      {charts.length > 0 && <button type="button" disabled={status !== 'ready' || exporting} onClick={() => { void save('png') }}>{t('downloadPng')}</button>}
    </div>
    {(diagnostic !== undefined || error !== undefined) && <div className={css.status} role="alert">{diagnostic ?? error}</div>}
    {!closed && diagnostic === undefined && <div className={css.status} role="status">{t('waiting')}</div>}
    {closed && !active && <div className={css.status}><span>{t('inactive')}</span> <button type="button" onClick={() => { activate(id) }}>{t('activate')}</button></div>}
    {closed && active && status === 'loading' && <div className={css.status} role="status">{t('loading')}</div>}
    {frame !== undefined && <iframe className={css.frame} hidden={showSource} style={{ height, display: showSource ? 'none' : undefined }} title={title || t('title')} sandbox="allow-scripts" srcDoc={frame.html} onLoad={(event) => { onLoad(frame, event.currentTarget.contentWindow as Window) }} />}
    {showSource && <pre className={css.source}><code>{block.code}</code></pre>}
  </dialog>
}
