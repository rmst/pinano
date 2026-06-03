import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { envWithFallbackTools } from "./fallback-tools.js"
import { DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js"

// /bin/bash if available, else sh. Keep this independent of $SHELL so user
// shell customization does not change tool semantics between machines.
export const DEFAULT_SHELL = existsSync("/bin/bash") ? "/bin/bash" : "sh"

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250
const MIN_EMPTY_POLL_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const APPROX_BYTES_PER_OUTPUT_TOKEN = 3
const SESSION_IDLE_TTL_MS = 10 * 60 * 1000
const MAX_STORED_OUTPUT_BYTES = 1024 * 1024
const MAX_SESSIONS = 32
const MIN_SESSION_ID = 1000
const MAX_SESSION_ID_EXCLUSIVE = 100000
const SESSION_ID_RANGE = MAX_SESSION_ID_EXCLUSIVE - MIN_SESSION_ID

function normalizeYieldTimeMs(value, defaultValue) {
	const ms = value === undefined ? defaultValue : value
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new Error("yield_time_ms must be a non-negative number")
	return Math.min(Math.floor(ms), MAX_YIELD_TIME_MS)
}

export function normalizeExecYieldTimeMs(value) {
	return normalizeYieldTimeMs(value, DEFAULT_EXEC_YIELD_TIME_MS)
}

export function normalizeWriteStdinYieldTimeMs(value, chars) {
	const yieldTimeMs = normalizeYieldTimeMs(value, DEFAULT_WRITE_STDIN_YIELD_TIME_MS)
	if (typeof chars === "string" && chars.length > 0) return yieldTimeMs
	return Math.max(yieldTimeMs, MIN_EMPTY_POLL_YIELD_TIME_MS)
}

export function maxOutputBytesForTokens(value) {
	const tokens = value === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : value
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) throw new Error("max_output_tokens must be a positive number")
	const wholeTokens = Math.floor(tokens)
	if (wholeTokens <= 0) throw new Error("max_output_tokens must be at least 1")
	return Math.min(wholeTokens * APPROX_BYTES_PER_OUTPUT_TOKEN, MAX_STORED_OUTPUT_BYTES)
}

function normalizeTimeoutMs(value) {
	if (value === undefined) return undefined
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("timeout_ms must be a positive number")
	return value
}

function trimUtf8Start(text, maxBytes) {
	const buffer = Buffer.from(text, "utf-8")
	if (buffer.length <= maxBytes) return { text, removedChars: 0 }
	let start = buffer.length - maxBytes
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
	const trimmed = buffer.slice(start).toString("utf-8")
	return { text: trimmed, removedChars: text.length - trimmed.length }
}

function appendTrailer(text, trailer) {
	return text ? `${text}\n${trailer}` : trailer
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

function signalName(signal) {
	if (signal === "interrupt") return "SIGINT"
	if (signal === "terminate") return "SIGTERM"
	if (signal === "kill") return "SIGKILL"
	throw new Error(`Unsupported signal: ${signal}`)
}

export class ProcessSession {
	constructor(options) {
		this.id = options.id
		this.command = options.cmd
		this.cwd = options.cwd
		this.shell = options.shell
		this.interactive = options.interactive
		this.createdAt = Date.now()
		this.lastActivityAt = this.createdAt
		this.output = ""
		this.readOffset = 0
		this.outputDroppedSinceRead = false
		this.running = true
		this.exitCode = null
		this.exitSignal = null
		this.timedOut = false
		this.finalReported = false
		this.stdinClosed = this.interactive === "none"
		this.idleTimer = undefined
		this.timeoutTimer = undefined
		this.exitWaiters = []

		const stdio = this.interactive === "pipe" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
		this.child = spawn(this.shell, ["-c", this.command], {
			cwd: this.cwd,
			env: envWithFallbackTools(process.env),
			detached: true,
			stdio,
		})

		this.child.stdout?.on("data", (chunk) => this.appendOutput(chunk))
		this.child.stderr?.on("data", (chunk) => this.appendOutput(chunk))
		this.child.on("error", (error) => {
			this.appendOutput(`${error.stack ?? error}\n`)
			this.running = false
			this.lastActivityAt = Date.now()
			this.exitCode = null
			this.exitSignal = "error"
			this.notifyExitWaiters()
		})
		this.child.on("close", (code, signal) => {
			this.running = false
			this.lastActivityAt = Date.now()
			this.exitCode = code
			this.exitSignal = signal
			if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
			this.notifyExitWaiters()
		})

		if (options.timeoutMs) {
			this.timeoutTimer = setTimeout(() => {
				this.timedOut = true
				this.sendSignal("kill")
			}, options.timeoutMs)
			this.timeoutTimer.unref?.()
		}
	}

	appendOutput(chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8")
		this.lastActivityAt = Date.now()
		this.output += text
		const trimmed = trimUtf8Start(this.output, MAX_STORED_OUTPUT_BYTES)
		if (trimmed.removedChars > 0) {
			this.output = trimmed.text
			if (this.readOffset >= trimmed.removedChars) this.readOffset -= trimmed.removedChars
			else {
				this.readOffset = 0
				this.outputDroppedSinceRead = true
			}
		}
	}

	notifyExitWaiters() {
		const waiters = this.exitWaiters
		this.exitWaiters = []
		for (const resolveWaiter of waiters) resolveWaiter()
	}

	waitForExitOrDelay(ms, signal) {
		if (!this.running || ms <= 0) return Promise.resolve()
		return new Promise((resolveWait, reject) => {
			let settled = false
			let resolveExit
			const cleanup = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				this.exitWaiters = this.exitWaiters.filter((waiter) => waiter !== resolveExit)
			}
			const finish = (fn) => {
				if (settled) return
				settled = true
				cleanup()
				fn()
			}
			const timer = setTimeout(() => finish(resolveWait), ms)
			const onAbort = () => finish(() => reject(new Error("Operation aborted")))
			resolveExit = () => finish(resolveWait)
			this.exitWaiters.push(resolveExit)
			if (signal?.aborted) onAbort()
			else signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	sendInput(input) {
		if (this.interactive === "none" || !this.child.stdin) {
			throw new Error("This session has no stdin. Start commands that need input with interactive: \"pipe\".")
		}
		if (this.stdinClosed || this.child.stdin.destroyed) throw new Error("stdin is closed for this session")
		this.child.stdin.write(input)
		this.lastActivityAt = Date.now()
	}

	closeStdin() {
		if (this.interactive === "none" || !this.child.stdin) {
			throw new Error("This session has no stdin. Start commands that need stdin close/EOF with interactive: \"pipe\".")
		}
		if (!this.stdinClosed && !this.child.stdin.destroyed) this.child.stdin.end()
		this.stdinClosed = true
		this.lastActivityAt = Date.now()
	}

	sendSignal(signal) {
		killProcessGroup(this.child.pid, signalName(signal))
		this.lastActivityAt = Date.now()
	}

	consumeOutput(maxOutputBytes) {
		let text = this.output.slice(this.readOffset)
		this.readOffset = this.output.length
		if (this.outputDroppedSinceRead) {
			text = appendTrailer(text, "[Older buffered output was dropped before this read]")
			this.outputDroppedSinceRead = false
		}
		return truncateTail(text, { maxBytes: maxOutputBytes, maxLines: DEFAULT_MAX_LINES })
	}

	formatResult(maxOutputBytes) {
		if (!this.running) this.finalReported = true
		const truncation = this.consumeOutput(maxOutputBytes)
		let output = truncation.content
		const trailers = []
		if (this.running) trailers.push(`[Session running: ${this.id}]`)
		if (this.timedOut) trailers.push("[Timed out]")
		if (truncation.truncated) {
			if (truncation.truncatedBy === "lines") {
				trailers.push(
					`[Truncated head: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)]`,
				)
			} else {
				trailers.push(
					`[Truncated head: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? MAX_STORED_OUTPUT_BYTES)} limit)]`,
				)
			}
		}
		if (!this.running && typeof this.exitCode === "number" && this.exitCode !== 0) trailers.push(`[Exit code: ${this.exitCode}]`)
		if (!this.running && this.exitSignal && this.exitSignal !== "error") trailers.push(`[Signal: ${this.exitSignal}]`)
		for (const trailer of trailers) output = appendTrailer(output, trailer)
		if (!output) output = this.running ? `(no output yet)\n[Session running: ${this.id}]` : "(no output)"
		return {
			content: [{ type: "text", text: output }],
			details: {
				session_id: this.running ? this.id : undefined,
				running: this.running,
				exit_code: this.exitCode,
				signal: this.exitSignal,
				timed_out: this.timedOut,
				stdin_closed: this.stdinClosed,
				truncation,
			},
		}
	}

	dispose(signal = "kill") {
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
		if (this.idleTimer) clearTimeout(this.idleTimer)
		if (this.running) this.sendSignal(signal)
	}
}

export class ProcessSessionManager {
	constructor() {
		this.sessions = new Map()
	}

	allocateSessionId() {
		while (true) {
			const randomBits = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16)
			const id = MIN_SESSION_ID + (randomBits % SESSION_ID_RANGE)
			if (!this.sessions.has(id)) return id
		}
	}

	resolveWorkdir(baseCwd, workdir) {
		const cwd = workdir ? resolve(baseCwd, workdir) : baseCwd
		if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`)
		return cwd
	}

	start(baseCwd, args) {
		this.cleanupExpired()
		if (this.sessions.size >= MAX_SESSIONS) throw new Error(`Too many running command sessions (${MAX_SESSIONS} max). Finish or signal an existing session first.`)
		const interactive = args.interactive ?? "none"
		if (!["none", "pipe"].includes(interactive)) throw new Error("interactive must be one of: none, pipe")
		const timeoutMs = normalizeTimeoutMs(args.timeout_ms)
		const session = new ProcessSession({
			id: this.allocateSessionId(),
			cmd: args.cmd,
			cwd: this.resolveWorkdir(baseCwd, args.workdir),
			shell: args.shell ?? DEFAULT_SHELL,
			interactive,
			timeoutMs,
		})
		this.sessions.set(session.id, session)
		this.scheduleIdleCleanup(session)
		return session
	}

	get(sessionId) {
		this.cleanupExpired()
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown command session: ${sessionId}`)
		session.lastActivityAt = Date.now()
		this.scheduleIdleCleanup(session)
		return session
	}

	delete(session) {
		this.sessions.delete(session.id)
		if (session.idleTimer) clearTimeout(session.idleTimer)
	}

	scheduleIdleCleanup(session) {
		if (session.idleTimer) clearTimeout(session.idleTimer)
		if (!session.running) return
		session.idleTimer = setTimeout(() => {
			if (Date.now() - session.lastActivityAt >= SESSION_IDLE_TTL_MS) {
				this.sessions.delete(session.id)
				session.dispose("terminate")
			}
		}, SESSION_IDLE_TTL_MS + 1000)
		session.idleTimer.unref?.()
	}

	cleanupExpired() {
		const now = Date.now()
		for (const session of this.sessions.values()) {
			if (session.running && now - session.lastActivityAt >= SESSION_IDLE_TTL_MS) {
				this.sessions.delete(session.id)
				session.dispose("terminate")
			} else if (!session.running && (session.finalReported || now - session.lastActivityAt >= SESSION_IDLE_TTL_MS)) {
				this.delete(session)
			}
		}
	}
}

export const processSessionManager = new ProcessSessionManager()

export async function waitForSession(session, yieldTimeMs, signal) {
	await session.waitForExitOrDelay(yieldTimeMs, signal)
}
