/** Structured macOS listener and working-directory observations. */
import type { SubprocessRuntime, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Read-only local listener observation; process creation labels never grant signalling authority. */
export interface NativeListener {
  pid: number
  name: string
  ports: number[]
  cwd?: string
  started?: string
}
/**
 * Decode lsof field records without splitting file names on whitespace.
 * @param text - NUL-delimited lsof -F0 output.
 * @returns Grouped process records.
 */
export function parseLsofRecords(text: string): NativeListener[] {
  const rows: NativeListener[] = []
  let current: NativeListener | undefined
  let cwd = false
  for (const raw of text.split('\0')) {
    const field = raw.replace(/^\n+/, '')
    if (field === '') continue
    const value = field.slice(1)
    switch (field[0]) {
      case 'p': {
        const pid = Number(value)
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid lsof process id')
        current = { pid, name: '', ports: [] }; rows.push(current); cwd = false
        break
      }
      case 'c': if (current !== undefined) current.name = value; break
      case 'f': cwd = value === 'cwd'; break
      case 'n': {
        if (current === undefined) throw new Error('lsof file without process record')
        if (cwd) { current.cwd = value; break }
        const match = /:(\d+)$/.exec(value)
        if (match === null) throw new Error('Invalid lsof listener address')
        const port = Number(match[1])
        if (port < 1 || port > 65535) throw new Error('Invalid lsof listener port')
        if (!current.ports.includes(port)) current.ports.push(port)
        break
      }
      default: break
    }
  }
  return rows
}
/**
 * Read bounded ps creation labels without interpreting command arguments.
 * @param text - ps pid/lstart/comm output in the C locale.
 * @returns Creation labels and executable names keyed by pid.
 */
export function parseProcessRecords(text: string): Map<number, { started: string; command: string }> {
  const result = new Map<number, { started: string; command: string }>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line)
    if (match === null) throw new Error('Invalid process inspection record')
    result.set(Number(match[1]), { started: match[2] as string, command: match[3] as string })
  }
  return result
}

/** Bounded process inspection settings owned by the native provider. */
export interface NativeScanConfig { scanTimeoutMs: number; scanMaxBytes: number; processInspectionMax: number; terminationGraceMs: number }
/** Structured native discovery through the public subprocess service. */
export class NativeDiscovery {
  constructor(private readonly subprocess: SubprocessRuntime, private readonly config: NativeScanConfig) {}
  private async run(argv: readonly string[], signal: AbortSignal, emptyAllowed = false): Promise<string> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.scanTimeoutMs)])
    const handle = this.subprocess.spawn({ argv, cwd: '/', env: { LC_ALL: 'C' }, signal: bounded,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.scanMaxBytes }, stderr: { maxBytes: this.config.scanMaxBytes } }, graceMs: this.config.terminationGraceMs })
    try {
      const outcome = await handle.done
      bounded.throwIfAborted()
      const stdout = (handle.collected.stdout as SubprocessOutputReader).readFrom(0),
        stderr = (handle.collected.stderr as SubprocessOutputReader).readFrom(0)
      if (stdout.lossy || stderr.lossy) throw new Error('Native scan exceeded output limit')
      if (outcome.exitCode !== 0 && !(emptyAllowed && outcome.exitCode === 1 && stdout.text === '' && stderr.text === '')) throw new Error('Native process inspection failed')
      return stdout.text
    } finally { handle.terminate(); await handle.waitForExit() }
  }
  /**
   * Observe listener, cwd and creation facts between two process inspections.
   * @param signal - Caller and Host scan cancellation.
   * @returns Current macOS listener observations.
   */
  async scan(signal: AbortSignal): Promise<NativeListener[]> {
    if (process.platform !== 'darwin') throw new Error('Native listener discovery requires macOS')
    const before = parseProcessRecords(await this.run(['/bin/ps', '-axo', 'pid=,lstart=,comm='], signal, true))
    const listeners = parseLsofRecords(await this.run(['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F0pcfn'], signal, true))
    if (listeners.length === 0) return []
    if (listeners.length > this.config.processInspectionMax) throw new Error('Native scan exceeded process inspection limit')
    const ids = listeners.map(row => row.pid).join(',')
    const cwdRecords = parseLsofRecords(await this.run(['/usr/sbin/lsof', '-a', '-p', ids, '-d', 'cwd', '-F0pfn'], signal, true))
    const directories = new Map(cwdRecords.map(row => [row.pid, row.cwd]))
    const after = parseProcessRecords(await this.run(['/bin/ps', '-p', ids, '-o', 'pid=,lstart=,comm='], signal, true))
    return listeners.flatMap((row) => {
      const first = before.get(row.pid), last = after.get(row.pid), cwd = directories.get(row.pid)
      if (first === undefined || last === undefined || first.started !== last.started || cwd === undefined) return []
      return [{ ...row, cwd, started: last.started }]
    })
  }
  /**
   * Recheck one creation label after managed membership observation.
   * @param listener - Observation to recheck.
   * @param signal - Inspection cancellation.
   * @returns Whether the current creation label still matches.
   */
  async current(listener: NativeListener, signal: AbortSignal): Promise<boolean> {
    const rows = parseProcessRecords(await this.run(['/bin/ps', '-p', String(listener.pid), '-o', 'pid=,lstart=,comm='], signal, true))
    return rows.get(listener.pid)?.started === listener.started
  }
}
