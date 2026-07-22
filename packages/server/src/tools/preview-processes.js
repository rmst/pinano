import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { previewLogPath } from "../app/preview/manifest.js"
import { envForToolSubprocess } from "./tool-env.js"

const DEFAULT_SHELL = existsSync("/bin/bash") ? "/bin/bash" : "sh"
const MAX_CAPTURE_BYTES = 256 * 1024
const DEFAULT_STOP_FORCE_AFTER_MS = 1000

function trimUtf8Start(text, maxBytes) {
	const buffer = Buffer.from(text, "utf-8")
	if (buffer.length <= maxBytes) return text
	let start = buffer.length - maxBytes
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
	return buffer.slice(start).toString("utf-8")
}

function killProcessGroup(pid, signalName) {
	if (!pid) return
	try {
		process.kill(-pid, signalName)
	} catch {
		try {
			process.kill(pid, signalName)
		} catch {}
	}
}

function resolveWorkdir(baseCwd) {
	if (typeof baseCwd !== "string" || !baseCwd) throw new Error("Preview base working directory is required")
	const cwd = resolve(baseCwd)
	if (!existsSync(cwd)) throw new Error(`Preview working directory does not exist: ${cwd}`)
	return cwd
}

function openPreviewLog(logPath, preview) {
	if (!logPath) return undefined
	try {
		mkdirSync(dirname(logPath), { recursive: true })
		const append = preview.appendLog === true
		const stream = createWriteStream(logPath, { flags: append ? "a" : "w", mode: 0o600 })
		stream.on("error", () => {})
		stream.write([
			`[pinano] --- ${append ? "restarting" : "starting"} ${new Date().toISOString()} ---`,
			`[pinano] preview ${preview.name} ${append ? "restarting" : "starting"}`,
			`[pinano] command: ${preview.command}`,
			`[pinano] cwd: ${preview.cwd}`,
			`[pinano] url: ${preview.publicUrl}`,
			"",
		].join("\n"))
		return stream
	} catch {
		return undefined
	}
}

class PreviewProcess {
	constructor(options) {
		this.id = options.id
		this.name = options.name
		this.command = options.command
		this.cwd = resolveWorkdir(options.baseCwd)
		this.port = options.port
		this.host = options.host
		this.publicUrl = options.publicUrl
		this.startedAt = Date.now()
		this.lastActivityAt = this.startedAt
		this.running = true
		this.exitCode = null
		this.exitSignal = null
		this.output = ""
		this.logPath = options.logPath ?? previewLogPath(process.env.PINANO_SESSION_DIR, this.name)
		this.appendLog = options.appendLog === true
		this.log = openPreviewLog(this.logPath, this)

		this.child = spawn(DEFAULT_SHELL, ["-c", this.command], {
			cwd: this.cwd,
			detached: true,
			env: envForToolSubprocess({
				...process.env,
				PINANO_PREVIEW: "1",
				PINANO_PREVIEW_ID: this.id,
				PINANO_PREVIEW_NAME: this.name,
				PINANO_HOST: this.host,
				PINANO_PORT: String(this.port),
				PINANO_PUBLIC_URL: this.publicUrl,
				...(this.logPath ? { PINANO_PREVIEW_LOG: this.logPath } : {}),
			}, { toolCallId: `preview:${this.id}` }),
			stdio: ["ignore", "pipe", "pipe"],
		})

		this.child.stdout?.on("data", (chunk) => this.appendOutput(chunk))
		this.child.stderr?.on("data", (chunk) => this.appendOutput(chunk))
		this.child.on("error", (err) => {
			this.appendOutput(`${err.stack ?? err}\n`)
			this.running = false
			this.lastActivityAt = Date.now()
			this.exitSignal = "error"
			this.closeLog("[pinano] preview process failed to spawn")
		})
		this.child.on("close", (code, signal) => {
			this.running = false
			this.lastActivityAt = Date.now()
			this.exitCode = code
			this.exitSignal = signal
			this.closeLog(`[pinano] preview process exited with ${signal ? `signal ${signal}` : `code ${code ?? 0}`}`)
		})
	}

	appendOutput(chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8")
		this.lastActivityAt = Date.now()
		this.output = trimUtf8Start(`${this.output}${text}`, MAX_CAPTURE_BYTES)
		this.log?.write(text)
	}

	closeLog(message) {
		const log = this.log
		this.log = undefined
		if (!log) return
		log.end(`\n${message}\n`)
	}

	touch() {
		this.lastActivityAt = Date.now()
	}

	stop(signal = "SIGTERM") {
		if (this.running) killProcessGroup(this.child.pid, signal)
	}

	inspect(now = Date.now()) {
		return {
			id: this.id,
			name: this.name,
			cwd: this.cwd,
			port: this.port,
			host: this.host,
			publicUrl: this.publicUrl,
			running: this.running,
			exitCode: this.exitCode,
			exitSignal: this.exitSignal,
			pid: this.child?.pid,
			ageMs: now - this.startedAt,
			idleMs: now - this.lastActivityAt,
			outputBytes: Buffer.byteLength(this.output ?? "", "utf-8"),
			logPath: this.logPath,
		}
	}
}

export class PreviewProcessManager {
	constructor() {
		this.processes = new Map()
	}

	start(options) {
		const existing = this.processes.get(options.id)
		if (existing?.running) {
			existing.touch()
			return existing.inspect()
		}
		if (existing) this.processes.delete(options.id)
		const process = new PreviewProcess(options)
		this.processes.set(options.id, process)
		return process.inspect()
	}

	forceStopLater(process, forceAfterMs) {
		if (!Number.isFinite(forceAfterMs) || forceAfterMs <= 0) return
		const timer = setTimeout(() => {
			if (process.running) process.stop("SIGKILL")
		}, forceAfterMs)
		timer.unref?.()
	}

	touch(id) {
		const process = this.processes.get(id)
		if (!process) return { ok: false }
		process.touch()
		return { ok: true, preview: process.inspect() }
	}

	stop(id, options = {}) {
		const process = this.processes.get(id)
		if (!process) return { ok: false }
		process.stop(options.signal ?? "SIGTERM")
		this.processes.delete(id)
		this.forceStopLater(process, options.forceAfterMs ?? DEFAULT_STOP_FORCE_AFTER_MS)
		return { ok: true }
	}

	stopAll(options = {}) {
		const processes = [...this.processes.values()]
		for (const process of processes) process.stop(options.signal ?? "SIGTERM")
		this.processes.clear()
		for (const process of processes) this.forceStopLater(process, options.forceAfterMs ?? DEFAULT_STOP_FORCE_AFTER_MS)
	}

	inspect(now = Date.now()) {
		for (const [id, process] of this.processes.entries()) {
			if (!process.running) this.processes.delete(id)
		}
		return {
			processCount: this.processes.size,
			processes: [...this.processes.values()].map((process) => process.inspect(now)),
		}
	}
}
