/** One assistant-owned preview; toolbar modes never relocate its iframe. */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, KeyboardEvent } from 'react'
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
  const root = useRef<HTMLDivElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
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
    const element = root.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') { enter(id); return () => { leave(id) } }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) enter(id)
      else if (!latestEnlarged.current) leave(id)
    })
    observer.observe(element)
    return () => { observer.disconnect(); leave(id) }
  }, [id, closed, enter, leave])

  useEffect(() => {
    const owner = ++lifecycle.current
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
      if (owner === lifecycle.current) ++lifecycle.current
      bridge.current?.dispose(); bridge.current = undefined
    }
  }, [active, closed, language, libraries, block.code, reload, config])

  useEffect(() => { bridge.current?.theme(theme) }, [theme])
  useEffect(() => {
    if (!enlarged) return
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [enlarged])

  const onLoad = (): void => {
    if (frame === undefined || iframe.current?.contentWindow === null || iframe.current?.contentWindow === undefined) return
    if (bridge.current !== undefined) {
      bridge.current.dispose(); bridge.current = undefined
      setFrame(undefined); setStatus('failed'); setError(t('navigated')); return
    }
    const channel = new MessageChannel()
    const owner = lifecycle.current
    bridge.current = new PreviewBridge(channel.port1, frame.generation, config, (message) => {
      if (owner !== lifecycle.current) return
      switch (message.type) {
        case 'height': setHeight(message.height); return
        case 'ready': setStatus('ready'); setTitle(message.title); setCharts(message.charts); bridge.current?.theme(latestTheme.current); return
        case 'error':
          setStatus('failed'); setError(message.error === 'readinessTimeout' ? t('readinessTimeout') : `${t('failed')}: ${message.error}`)
          bridge.current?.dispose(); bridge.current = undefined; setFrame(undefined); return
      }
    })
    iframe.current.contentWindow.postMessage({ type: 'dsh-preview-init', generation: frame.generation }, '*', [channel.port2])
  }
  const close = (): void => { setEnlarged(false); opener.current?.focus() }
  const keyDown = (event: KeyboardEvent): void => {
    if (!enlarged) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,iframe:not([hidden])') ?? [])]
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
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
      } else if (kind === 'html' && frame !== undefined && language !== undefined) {
        const html = createStandaloneDocument({ source: block.code, language, assets: frame.assets, theme: latestTheme.current })
        download(new TextEncoder().encode(html), 'text/html', filename(title || t('title'), 'html'))
      } else if ((kind === 'svg' || kind === 'png') && bridge.current !== undefined) {
        const response = await bridge.current.export(kind, kind === 'png' ? chart : undefined)
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
  return <div ref={root} className={`${css.preview} ${enlarged ? css.enlarged : ''}`} data-visualization role={enlarged ? 'dialog' : undefined} aria-modal={enlarged || undefined} aria-label={title || t('title')} onKeyDown={keyDown}>
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
    {frame !== undefined && <iframe ref={iframe} className={css.frame} hidden={showSource} style={{ height, display: showSource ? 'none' : undefined }} title={title || t('title')} sandbox="allow-scripts" srcDoc={frame.html} onLoad={onLoad} />}
    {showSource && <pre className={css.source}><code>{block.code}</code></pre>}
  </div>
}
