/** Native launch preparation through public subprocess and sandboxed shell APIs. */
import { isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import type { ShellExecRequest, ShellProcess } from '@deepseek-ai/dsh-shell'
import type { ServiceCommand, ServiceNativeExecution, ServiceNativeLaunch, ServiceNativeLifetime, ServiceNativeProcess } from '@deepseek-ai/dsh-project-services'

/**
 * Quote exact argv for a POSIX shell without expanding user argument bytes.
 * @param command - Exact executable and arguments.
 * @returns Shell invocation preserving empty arguments.
 */
export function nativeCommandText(command: ServiceCommand): string {
  return command.argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
}
function executableRequest(program: string, cwd: string): string {
  return !isAbsolute(program) && program.includes('/') ? resolve(cwd, program) : program
}
function subprocessProcess(handle: SubprocessHandle): ServiceNativeProcess {
  // Both streams use collection in the fully resolved human launch.
  const stdout = handle.collected.stdout as SubprocessOutputReader, stderr = handle.collected.stderr as SubprocessOutputReader
  const ownsProcess = handle.ownsProcess?.bind(handle)
  let stdoutOffset = 0, stderrOffset = 0
  return {
    done: handle.done,
    readOutput: () => {
      const out = stdout.readFrom(stdoutOffset), err = stderr.readFrom(stderrOffset)
      stdoutOffset = out.nextOffset; stderrOffset = err.nextOffset
      return { text: out.text + (err.text === '' ? '' : `\n[stderr]\n${err.text}`), lossy: out.lossy || err.lossy }
    },
    terminate: async () => { handle.terminate(); await handle.waitForExit() },
    waitForExit: async () => { await handle.waitForExit() },
    ...ownsProcess === undefined ? {} : { ownsProcess },
  }
}
function shellProcess(proc: ShellProcess): ServiceNativeProcess {
  const ownsProcess = proc.ownsProcess?.bind(proc)
  return {
    done: proc.done.then(() => ({ exitCode: proc.exitCode, signal: proc.signal })),
    readOutput: () => { const output = proc.readOutput(); return { text: output.delta, lossy: output.lossy } },
    terminate: () => proc.terminate(), waitForExit: () => proc.waitForExit(),
    ...ownsProcess === undefined ? {} : { ownsProcess },
  }
}
/**
 * Create a trusted adapter using the initiating context's actual sandboxed shell.
 * @param ctx - Initiating context with shell and subprocess providers.
 * @param lifetime - Host identity captured by the native provider.
 * @param request - Current sandbox policy and transient execution environment.
 * @returns Adapter whose preparation fails before any existing service is stopped.
 */
export function createShellServiceExecution(ctx: Context, lifetime: ServiceNativeLifetime, request: Omit<ShellExecRequest, 'command' | 'workdir' | 'signal'>): ServiceNativeExecution {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('Native agent execution requires a shell provider')
  if (!shell.supportsPosixCommandSyntax) throw new Error('Native agent execution requires POSIX command syntax')
  if (ctx[Context.isolate]['subprocess'] !== lifetime.subprocessRealm) throw new Error('Native execution subprocess provider differs from Host')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('Native agent execution requires a subprocess provider')
  return {
    lifetime,
    resolve: async (command, cwd, signal) => {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted()
      const spec = shell.resolve({ ...request, captureRangeOutput: true, command: nativeCommandText(command), workdir: cwd, signal })
      const program = await subprocess.resolveExecutable(executableRequest(command.argv[0] as string, spec.workdir), spec.env, signal)
      const captured = { argv: [program, ...command.argv.slice(1)] }
      const prepared = await shell.prepare({ ...spec, command: nativeCommandText(captured) })
      signal.throwIfAborted()
      return { command: captured, cwd, start: async hostSignal => shellProcess(await prepared.start(hostSignal)) }
    },
  }
}
/**
 * Resolve a human launch through an explicitly configured local POSIX shell.
 * @param subprocess - Host-lived subprocess provider.
 * @param command - Exact executable and arguments.
 * @param cwd - Captured checkout directory.
 * @param config - Shell path and process resource bounds.
 * @param signal - Preparation cancellation.
 * @returns Side-effect-free resolved launch.
 */
export async function resolveHumanLaunch(
  subprocess: SubprocessRuntime, command: ServiceCommand, cwd: string,
  config: { shellPath: string; retainedOutputBytes: number; terminationGraceMs: number }, signal: AbortSignal,
): Promise<ServiceNativeLaunch> {
  const shell = await subprocess.resolveExecutable(config.shellPath, undefined, signal)
  const executable = await subprocess.resolveExecutable(executableRequest(command.argv[0] as string, cwd), undefined, signal)
  signal.throwIfAborted()
  const captured = { argv: [executable, ...command.argv.slice(1)] }
  const spec = { argv: [shell, '-c', `exec ${nativeCommandText(captured)}`], cwd,
    stdio: { stdin: 'ignore' as const, stdout: { maxBytes: config.retainedOutputBytes, untilRangeExit: true as const },
      stderr: { maxBytes: config.retainedOutputBytes, untilRangeExit: true as const } }, graceMs: config.terminationGraceMs }
  return { command: captured, cwd,
    start: hostSignal => Promise.resolve(subprocessProcess(subprocess.spawn({ ...spec, signal: hostSignal }))) }
}
