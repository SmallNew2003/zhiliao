import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('terminates range survivors after the direct shell completes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'service-range-')))
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const executor = await ctx.plugin(LocalBashExecutor, { graceMs: 50 })
  const childScript = 'require("node:net").createServer(s=>s.end("alive")).listen(0,"127.0.0.1",function(){process.send(this.address().port)});'
  const script = `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:["ignore","ignore","inherit","ipc"]});c.on("message",p=>{console.log(p);process.exit(0)});`
  const proc = await ctx.shell.start(ctx.shell.resolve({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, workdir: root }))
  try {
    let output = ''
    await expect.poll(() => { output += proc.readOutput().delta; return /\d+/.test(output) }).toBe(true)
    const port = Number(/\d+/.exec(output)![0])
    await proc.done
    expect(proc.status).toBe('completed')
    const { connect } = await import('node:net')
    const responds = () => new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('data', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    expect(await responds()).toBe(true)
    await proc.terminate()
    await proc.waitForExit()
    expect(await responds()).toBe(false)
  } finally {
    await executor.dispose()
    await subprocess.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('captures surviving child output after direct done and closes capture at range quiescence', async () => {
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const executor = await ctx.plugin(LocalBashExecutor, { graceMs: 50 })
  const childScript = 'process.stdout.on("error",()=>{});require("node:net").createServer(s=>{process.stdout.write("LATE\\n",e=>s.end(e?"pipe-error":"alive"))}).listen(0,"127.0.0.1",function(){process.send(this.address().port)});'
  const script = `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:["ignore","inherit","inherit","ipc"]});c.on("message",p=>{console.log(p);process.exit(0)});`
  const proc = await ctx.shell.start(ctx.shell.resolve({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, workdir: tmpdir(), captureRangeOutput: true }))
  try {
    let output = ''
    await expect.poll(() => { output += proc.readOutput().delta; return /\d+/.test(output) }).toBe(true)
    const port = Number(/\d+/.exec(output)![0])
    await proc.done
    const { connect } = await import('node:net')
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('data', (chunk) => { socket.destroy(); resolve(chunk.toString()) })
      socket.once('error', (error) => { socket.destroy(); reject(error) })
    })
    expect(response).toBe('alive')
    await expect.poll(() => { output += proc.readOutput().delta; return output }).toContain('LATE\n')
    await proc.terminate(); await proc.waitForExit()
    expect(proc.readOutput().delta).toBe('')
  } finally { await executor.dispose(); await subprocess.dispose() }
})

it.skipIf(process.platform !== 'darwin')('observes only members of the currently owned range', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], cwd: tmpdir(), stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 50 })
  try {
    await expect.poll(() => handle.collected.stdout!.readFrom(0).text).toMatch(/\d+/)
    const pid = Number(handle.collected.stdout!.readFrom(0).text.trim())
    expect(await handle.ownsProcess!(pid)).toBe(true)
    expect(await handle.ownsProcess!(process.pid)).toBe(false)
    handle.terminate()
    await handle.waitForExit()
    expect(await handle.ownsProcess!(pid)).toBe(false)
  } finally { await fiber.dispose() }
})
