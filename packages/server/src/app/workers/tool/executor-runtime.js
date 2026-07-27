import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { markUncertainToolExecution } from "../../../agent-core/tool-errors.js"
import { PROCESS_SESSION_IDLE_TTL_MS } from "../../../tools/process-session-limits.js"
import { loadEnvironmentRegistry, resolveExecutionEnvironment, resolveSessionWd } from "../../environment/registry.js"
import { recordFileCheckpoint } from "../../session/file-checkpoints.js"
import { JsonLineRpc } from "../../json-rpc-lines.js"
import { optionalSessionWorkspacePath } from "../../paths.js"
import { stateMountFromSettings } from "../../settings.js"
import { sandboxWithSessionMounts, sessionSandboxBaseWd, sessionSandboxMounts } from "../../session/config.js"
import { getEffectiveSessionProperties } from "../../session/properties.js"
import { ManagedContainerPreviewProcess, createWorkerLauncher } from "../launchers.js"
import { WORKER_PROTOCOL_VERSION, assertWorkerProtocolVersion } from "../protocol.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultToolWorkerPath = join(here, "worker.js")
const DEFAULT_WORKER_INSPECT_TIMEOUT_MS = 500
const DEFAULT_IDLE_WORKER_TTL_MS = 60 * 1000
const DEFAULT_IDLE_WORKER_RECHECK_MS = 60 * 1000
const PROCESS_SESSION_BACKGROUND_GRACE_MS = 30 * 1000

function sandboxBaseWdForSession(session, fallbackCwd) {
	const config = session?.getSessionConfig?.() ?? {}
	return sessionSandboxBaseWd(config, session?.getMetadata?.()?.cwd ?? fallbackCwd)
}

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

function shortHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

function nonNegativeFiniteMs(value, fallback, label) {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number`)
	return Math.floor(value)
}

function processSessionId(value) {
	if (value === undefined || value === null || value === "") return undefined
	const id = Number(value)
	return Number.isFinite(id) ? String(id) : undefined
}

function workerProcessSessionKey(workerKey, sessionId) {
	return `${workerKey}\0${sessionId}`
}

function workerPreviewProcessKey(workerKey, previewId) {
	return `${workerKey}\0${previewId}`
}

class ToolWorkerConnection {
	/**
	 * @param {object} options
	 * @param {string} options.environmentId
	 * @param {any} options.target
	 * @param {any} options.sandbox
	 * @param {string | undefined} options.startCwd
	 * @param {string | undefined} options.sessionWd
	 * @param {string | undefined} options.sessionDir
	 * @param {string | undefined} options.sessionId
	 * @param {string | undefined} options.previewAccessToken
	 * @param {any} options.launcher
	 * @param {string} options.workerPath
	 * @param {() => import("../../../session-manager/session.js").Session | null | undefined} options.getSession
	 * @param {(request: any) => Promise<any>} [options.codeModeApiRequest]
	 */
	constructor(options) {
		this.environmentId = options.environmentId
		this.target = options.target
		this.sandbox = options.sandbox
		this.startCwd = options.startCwd
		this.sessionWd = options.sessionWd
		this.sessionDir = options.sessionDir
		this.sessionId = options.sessionId
		this.previewAccessToken = options.previewAccessToken
		this.launcher = options.launcher
		this.workerPath = options.workerPath
		this.getSession = options.getSession
		this.codeModeApiRequest = options.codeModeApiRequest
		this.workerHandle = undefined
		this.child = undefined
		this.rpc = undefined
		this.dead = false
		this.disposed = false
		this.activeRequestCount = 0
		this.lastUsedAt = Date.now()
		this.workerStderr = ""
		this.pendingToolUpdates = new Map()
		this.codeModeCells = new Map()
		this.exitPromise = Promise.resolve(undefined)
		this.ready = this.startWorker()
			.then(() => {
				if (this.dead) throw new Error("Tool executor was disposed before init")
				return this.initWorker({
					protocolVersion: WORKER_PROTOCOL_VERSION,
					cwd: this.startCwd,
					previewAccessToken: this.previewAccessToken,
				})
			})
			.then((result) => {
				assertWorkerProtocolVersion(result?.protocolVersion)
				return this
			})
		this.ready.catch(() => {})
	}

	formatWorkerExitError(context, exit = {}) {
		const status = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`
		const stderr = this.workerStderr.trim()
		return new Error(`${context} (${status})${stderr ? `\nWorker stderr:\n${stderr}` : ""}`)
	}

	async startWorker() {
		const handle = await this.launcher.start({ cwd: this.startCwd, sessionWd: this.sessionWd, sessionDir: this.sessionDir, sessionId: this.sessionId, environmentId: this.environmentId, workerPath: this.workerPath })
		if (this.dead) {
			handle.stop?.()
			throw new Error("Tool executor was disposed before startup completed")
		}
		this.workerHandle = handle
		this.child = handle.child
		this.child.stderr?.on("data", (chunk) => {
			this.workerStderr += chunk.toString()
			if (this.workerStderr.length > 8000) this.workerStderr = this.workerStderr.slice(-8000)
			process.stderr.write(`[tool-worker:${this.environmentId}] ${chunk}`)
		})
		this.exitPromise = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => {
				this.dead = true
				this.pendingToolUpdates.clear()
				this.failCodeModeCells(markUncertainToolExecution(this.formatWorkerExitError("Tool executor exited while running a code-mode cell", { code, signal })))
				resolve({ code, signal })
			})
		})
		this.rpc = new JsonLineRpc({
			input: this.child.stdout,
			output: this.child.stdin,
			rejectPendingOnClose: false,
			onRequest: (method, params) => this.handleWorkerRequest(method, params),
			onNotification: (method, params) => this.handleWorkerNotification(method, params),
			onProtocolError: (err) => process.stderr.write(`[tool-worker:${this.environmentId}] ${err.stack || err}\n`),
			onClose: () => {
				this.dead = true
				this.pendingToolUpdates.clear()
				this.failCodeModeCells(markUncertainToolExecution(new Error("Tool executor connection closed while running a code-mode cell")))
				if (!this.disposed) this.workerHandle?.stop?.()
			},
		})
	}

	get unexpectedExit() {
		return this.dead && !this.disposed
	}

	hasActiveRequests() {
		return this.activeRequestCount > 0
			|| this.pendingToolUpdates.size > 0
			|| [...this.codeModeCells.values()].some((cell) => cell.running)
	}

	touch(now = Date.now()) {
		this.lastUsedAt = now
	}

	async initWorker(params) {
		if (this.dead) throw new Error("Tool executor was disposed before init")
		const request = this.rpc.request("init", params)
		const exited = this.exitPromise.then((exit) => {
			throw this.formatWorkerExitError("Tool executor exited before init", exit)
		})
		const result = await Promise.race([request, exited])
		if (result === undefined) {
			const exit = await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(() => resolve({}), 50))])
			throw this.formatWorkerExitError("Tool executor closed before init", exit)
		}
		return result
	}

	async requestWorker(method, params) {
		const request = this.rpc.request(method, params)
		const exited = this.exitPromise.then(({ code, signal }) => {
			throw new Error(`Tool executor exited during ${method}${signal ? ` (${signal})` : code === null ? "" : ` (code ${code})`}`)
		})
		const result = await Promise.race([request, exited])
		if (result === undefined) throw new Error(`Tool executor closed during ${method}`)
		return result
	}

	/**
	 * @param {string} name
	 * @param {string} id
	 * @param {any} args
	 * @param {string} cwd
	 * @param {AbortSignal | undefined} signal
	 * @param {(update: any) => void} [onUpdate]
	 * @param {{ scope?: any, environmentId?: string, toolProfile?: "default" | "codex" }} [options]
	 */
	async executeTool(name, id, args, cwd, signal, onUpdate, options = {}) {
		if (this.dead) throw new Error("Tool executor is not running")
		this.activeRequestCount += 1
		this.touch()
		try {
			await this.ready
			if (signal?.aborted) throw new Error("Operation aborted")
			if (onUpdate) this.pendingToolUpdates.set(id, onUpdate)
			const cancel = () => {
				this.rpc.request("cancelTool", { id }).catch(() => {})
			}
			if (signal) signal.addEventListener("abort", cancel, { once: true })
			try {
				return await this.requestWorker("executeTool", {
					id,
					name,
					args,
					cwd,
					scope: options.scope,
					environmentId: options.environmentId,
					toolProfile: options.toolProfile,
				})
			} catch (error) {
				if (error instanceof Error && /^Tool executor (?:exited|closed) during executeTool/.test(error.message)) {
					throw markUncertainToolExecution(error)
				}
				throw error
			} finally {
				if (signal) signal.removeEventListener("abort", cancel)
				this.pendingToolUpdates.delete(id)
			}
		} finally {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
			this.touch()
		}
	}

	async startCodeModeCell(params, callbacks) {
		if (this.dead) throw new Error("Tool executor is not running")
		if (this.codeModeCells.has(params.id)) throw new Error(`Code-mode cell ${params.id} already exists`)
		this.activeRequestCount += 1
		this.touch()
		const cell = {
			id: params.id,
			running: true,
			onToolCall: callbacks.onToolCall,
			onEvent: callbacks.onEvent,
			onFailure: callbacks.onFailure,
		}
		this.codeModeCells.set(cell.id, cell)
		try {
			await this.ready
			await this.requestWorker("startCodeModeCell", params)
		} catch (error) {
			if (this.codeModeCells.get(cell.id) === cell) this.codeModeCells.delete(cell.id)
			throw error
		} finally {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
			this.touch()
		}

		let closed = false
		const close = () => {
			if (closed) return
			closed = true
			if (this.codeModeCells.get(cell.id) === cell) this.codeModeCells.delete(cell.id)
			if (!this.dead) this.rpc.notify("terminateCodeModeCell", { id: cell.id })
			this.touch()
		}
		return {
			id: cell.id,
			resetOutput: () => {
				if (!closed && !this.dead) this.rpc.notify("resetCodeModeCellOutput", { id: cell.id })
			},
			terminate: () => {
				if (!closed && !this.dead) this.rpc.notify("terminateCodeModeCell", { id: cell.id })
				cell.running = false
				this.touch()
			},
			close,
		}
	}

	failCodeModeCells(error) {
		const cells = [...this.codeModeCells.values()]
		this.codeModeCells.clear()
		for (const cell of cells) {
			if (!cell.running) continue
			cell.running = false
			cell.onFailure?.(error)
		}
	}

	async startPreviewProcess(params) {
		if (this.dead) throw new Error("Tool executor is not running")
		this.activeRequestCount += 1
		this.touch()
		try {
			await this.ready
			return await this.requestWorker("startPreviewProcess", params)
		} finally {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
			this.touch()
		}
	}

	async touchPreviewProcess(id) {
		if (this.dead) throw new Error("Tool executor is not running")
		this.activeRequestCount += 1
		this.touch()
		try {
			await this.ready
			return await this.requestWorker("touchPreviewProcess", { id })
		} finally {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
			this.touch()
		}
	}

	async stopPreviewProcess(id) {
		if (this.dead) return { ok: false }
		this.activeRequestCount += 1
		this.touch()
		try {
			await this.ready
			return await this.requestWorker("stopPreviewProcess", { id })
		} finally {
			this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
			this.touch()
		}
	}

	async handleWorkerRequest(method, params = {}) {
		if (method === "beforeFileMutation") {
			return recordFileCheckpoint(this.getSession(), params.absolutePath, this.workspace)
		}
		if (method === "codeModeApi" || method === "pinanoApi") {
			if (!this.codeModeApiRequest) throw new Error("Cerex code-mode API is unavailable for this session")
			return this.codeModeApiRequest(params)
		}
		if (method === "internalHttp") {
			if (!this.codeModeApiRequest) throw new Error("Cerex internal API is unavailable for this session")
			const workerContext = Object.fromEntries(Object.entries({
				environmentId: this.environmentId,
				target: this.target,
				sandbox: this.sandbox,
				startCwd: this.startCwd,
				sessionWd: this.sessionWd,
				sessionDir: this.sessionDir,
			}).filter(([, value]) => value !== undefined))
			return this.codeModeApiRequest({
				op: "internalHttp",
				request: params,
				workerContext,
			})
		}
		if (method === "codeModeToolCall") {
			const cell = this.codeModeCells.get(params.id)
			if (!cell?.running) throw new Error(`Code-mode cell ${params.id} is not running`)
			return cell.onToolCall(params.request)
		}
		throw new Error(`Unknown tool worker request: ${method}`)
	}

	handleWorkerNotification(method, params = {}) {
		if (method === "toolUpdate") {
			this.pendingToolUpdates.get(params.id)?.(params.update)
			return
		}
		if (method === "codeModeEvent") {
			const cell = this.codeModeCells.get(params.id)
			if (!cell?.running) return
			if (params.method === "complete") cell.running = false
			cell.onEvent?.(params.method, params.params)
			return
		}
		if (method === "codeModeFailure") {
			const cell = this.codeModeCells.get(params.id)
			if (!cell?.running) return
			cell.running = false
			const error = Object.assign(new Error(params.error?.message || "Code-mode runner failed"), params.error)
			cell.onFailure?.(error)
			return
		}
	}

	async inspect(key = "", options = {}) {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_WORKER_INSPECT_TIMEOUT_MS
		const base = {
			keyHash: key ? shortHash(key) : undefined,
			environmentId: this.environmentId,
			startCwd: this.startCwd,
			pid: this.child?.pid,
			dead: this.dead,
			disposed: this.disposed,
			unexpectedExit: this.unexpectedExit,
			activeRequestCount: this.activeRequestCount,
			lastUsedAgeMs: Date.now() - this.lastUsedAt,
			pendingToolUpdateCount: this.pendingToolUpdates.size,
			codeModeCellCount: this.codeModeCells.size,
			stderrBytes: Buffer.byteLength(this.workerStderr ?? "", "utf-8"),
		}
		if (this.dead) return base
		const request = (async () => {
			await this.ready
			return this.requestWorker("inspect", {})
		})().then(
			(result) => ({ ...base, worker: result }),
			(err) => ({ ...base, inspectError: err?.message ?? String(err) }),
		)
		return Promise.race([
			request,
			delay(timeoutMs, { ...base, inspectTimedOut: true }),
		])
	}

	dispose() {
		this.disposed = true
		this.dead = true
		this.failCodeModeCells(new Error("Tool executor was disposed while running a code-mode cell"))
		if (this.rpc) this.rpc.rejectPendingOnClose = false
		this.workerHandle?.stop?.()
	}
}

export class ToolExecutorRuntime {
	/**
	 * @param {object} options
	 * @param {string} options.cwd
	 * @param {any} [options.workerLauncher]
	 * @param {string} [options.workerPath]
	 * @param {() => import("../../../session-manager/session.js").Session | null | undefined} [options.getSession]
	 * @param {(request: any) => Promise<any>} [options.codeModeApiRequest]
	 * @param {() => any} [options.environmentRegistry]
	 * @param {() => any} [options.getSettings]
	 * @param {import("../../workspace/client.js").WorkspaceClient} [options.workspace]
	 * @param {string} [options.previewAccessToken]
	 * @param {number} [options.idleWorkerTtlMs]
	 * @param {number} [options.idleWorkerRecheckMs]
	 * @param {number} [options.idleWorkerInspectTimeoutMs]
	 * @param {(options: any) => Promise<any>} [options.managedContainerPreviewFactory]
	 */
	constructor(options) {
		this.cwd = options.cwd
		this.getSession = options.getSession ?? (() => undefined)
		this.codeModeApiRequest = options.codeModeApiRequest
		this.fixedWorkerLauncher = options.workerLauncher
		this.workerPath = options.workerPath ?? defaultToolWorkerPath
		this.environmentRegistry = options.environmentRegistry
		this.getSettings = options.getSettings
		this.workspace = options.workspace
		this.previewAccessToken = options.previewAccessToken
		this.idleWorkerTtlMs = nonNegativeFiniteMs(options.idleWorkerTtlMs, DEFAULT_IDLE_WORKER_TTL_MS, "idleWorkerTtlMs")
		this.idleWorkerRecheckMs = nonNegativeFiniteMs(options.idleWorkerRecheckMs, Math.min(DEFAULT_IDLE_WORKER_RECHECK_MS, Math.max(1000, this.idleWorkerTtlMs || 1000)), "idleWorkerRecheckMs")
		this.idleWorkerInspectTimeoutMs = nonNegativeFiniteMs(options.idleWorkerInspectTimeoutMs, DEFAULT_WORKER_INSPECT_TIMEOUT_MS, "idleWorkerInspectTimeoutMs")
		this.workers = new Map()
		this.startCwds = new Map()
		this.idleWorkerTimers = new Map()
		this.knownProcessSessions = new Map()
		this.knownPreviewProcesses = new Map()
		this.containerPreviewProcesses = new Map()
		this.managedContainerPreviewFactory = options.managedContainerPreviewFactory ?? (async (previewOptions) => {
			const preview = new ManagedContainerPreviewProcess(previewOptions)
			await preview.start()
			return preview
		})
		this.disposed = false
		this.lastWorker = undefined
		this.ready = Promise.resolve(this)
	}

	get child() {
		return this.lastWorker?.child
	}

	get exitPromise() {
		return this.lastWorker?.exitPromise ?? Promise.resolve(undefined)
	}

	get isDead() {
		return this.disposed || this.lastWorker?.unexpectedExit === true
	}

	resolveTargetFor(session, props, registry, environmentId = undefined) {
		const effectiveProps = environmentId ? { ...(props ?? {}), environmentId } : props
		const target = resolveExecutionEnvironment(effectiveProps, this.cwd, registry)
		const config = session?.getSessionConfig?.() ?? {}
		const sandbox = sandboxWithSessionMounts(target.sandbox, sessionSandboxMounts(config))
		const sessionWd = resolveSessionWd(effectiveProps, sandboxBaseWdForSession(session, this.cwd), registry)
		const sessionId = session?.getMetadata?.()?.id
		const sessionDir = target.target?.type === "local" ? optionalSessionWorkspacePath(sessionId) : undefined
		const stateMount = stateMountFromSettings(this.getSettings?.())
		return { ...target, sandbox, sessionWd, sessionDir, sessionId, stateMount, workerScope: sessionId ? `session:${sessionId}` : "runtime" }
	}

	resolveTarget() {
		const registry = this.environmentRegistry?.() ?? loadEnvironmentRegistry()
		const session = this.getSession()
		const props = session ? getEffectiveSessionProperties(session) : undefined
		return this.resolveTargetFor(session, props, registry)
	}

	workerKey(target) {
		return `${target.workerScope}\0${target.environmentId}\0${JSON.stringify(target.target)}\0${JSON.stringify(target.sandbox)}\0${target.stateMount || false}`
	}

	clearWorkerIdleTimer(key) {
		const timer = this.idleWorkerTimers.get(key)
		if (!timer) return
		clearTimeout(timer)
		this.idleWorkerTimers.delete(key)
	}

	forgetProcessSessionsForWorker(key) {
		for (const sessionKey of this.knownProcessSessions.keys()) {
			if (sessionKey.startsWith(`${key}\0`)) this.knownProcessSessions.delete(sessionKey)
		}
	}

	forgetPreviewProcessesForWorker(key) {
		for (const previewKey of this.knownPreviewProcesses.keys()) {
			if (previewKey.startsWith(`${key}\0`)) this.knownPreviewProcesses.delete(previewKey)
		}
	}

	removeWorker(key, worker, options = {}) {
		this.clearWorkerIdleTimer(key)
		this.forgetProcessSessionsForWorker(key)
		this.forgetPreviewProcessesForWorker(key)
		if (this.workers.get(key) === worker) this.workers.delete(key)
		if (options.clearLastWorker === true && this.lastWorker === worker) this.lastWorker = undefined
	}

	scheduleWorkerIdleCheck(key, worker, delayMs = undefined) {
		this.clearWorkerIdleTimer(key)
		if (this.disposed || worker.dead || this.workers.get(key) !== worker) return
		const ageMs = Date.now() - worker.lastUsedAt
		const dueInMs = this.idleWorkerTtlMs - ageMs
		const nextDelayMs = delayMs ?? (dueInMs > 0 ? dueInMs : this.idleWorkerRecheckMs)
		const timer = setTimeout(() => {
			this.idleWorkerTimers.delete(key)
			this.pruneIdleWorker(key, worker).catch((err) => {
				process.stderr.write(`[tool-worker:${worker.environmentId}] idle prune failed: ${err?.stack ?? err}\n`)
			})
		}, Math.max(1, nextDelayMs))
		timer.unref?.()
		this.idleWorkerTimers.set(key, timer)
	}

	async workerHasRetainedProcessSessions(key, worker) {
		const inspected = await worker.inspect(key, { timeoutMs: this.idleWorkerInspectTimeoutMs })
		if (worker.dead || inspected.dead) return false
		if (inspected.inspectTimedOut || inspected.inspectError) return true
		const processSessionCount = inspected.worker?.processSessions?.sessionCount ?? 0
		const previewProcessCount = inspected.worker?.previewProcesses?.processCount ?? 0
		const activeToolCount = Array.isArray(inspected.worker?.activeTools) ? inspected.worker.activeTools.length : 0
		return processSessionCount > 0 || previewProcessCount > 0 || activeToolCount > 0
	}

	async pruneIdleWorker(key, worker, now = Date.now()) {
		if (this.disposed || this.workers.get(key) !== worker) return false
		if (worker.dead) {
			this.removeWorker(key, worker, { clearLastWorker: worker.disposed })
			return false
		}
		if (worker.hasActiveRequests() || now - worker.lastUsedAt < this.idleWorkerTtlMs) {
			this.scheduleWorkerIdleCheck(key, worker)
			return false
		}
		if (await this.workerHasRetainedProcessSessions(key, worker)) {
			this.scheduleWorkerIdleCheck(key, worker, this.idleWorkerRecheckMs)
			return false
		}
		if (worker.dead) {
			this.removeWorker(key, worker, { clearLastWorker: worker.disposed })
			return false
		}
		if (this.disposed || this.workers.get(key) !== worker || worker.hasActiveRequests()) return false
		worker.dispose()
		this.removeWorker(key, worker, { clearLastWorker: true })
		return true
	}

	async pruneIdleWorkers(now = Date.now()) {
		this.forgetExpiredKnownProcessSessions(now)
		this.forgetExpiredKnownPreviewProcesses(now)
		const entries = [...this.workers.entries()]
		const results = await Promise.all(entries.map(([key, worker]) => this.pruneIdleWorker(key, worker, now)))
		return results.filter(Boolean).length
	}

	async workerFor(target, key = this.workerKey(target)) {
		let startCwd = target.cwd
		if (target.sandbox?.type && target.sandbox.type !== "none") {
			if (!this.startCwds.has(key)) this.startCwds.set(key, target.sandbox?.useSessionWd === false ? undefined : target.sessionWd ?? target.cwd)
			startCwd = this.startCwds.get(key)
		}
		const existing = this.workers.get(key)
		if (existing && !existing.dead) {
			this.lastWorker = existing
			existing.touch()
			this.scheduleWorkerIdleCheck(key, existing)
			return existing
		}
		if (existing) {
			existing.dispose()
			this.removeWorker(key, existing, { clearLastWorker: this.lastWorker === existing })
		}
		const worker = new ToolWorkerConnection({
			environmentId: target.environmentId,
			target: target.target,
			sandbox: target.sandbox,
			startCwd,
			sessionWd: target.sessionWd,
			sessionDir: target.sessionDir,
			sessionId: target.sessionId,
			launcher: this.fixedWorkerLauncher ?? createWorkerLauncher({ target: target.target, sandbox: target.sandbox, stateMount: target.stateMount }),
			workerPath: this.workerPath,
			previewAccessToken: this.previewAccessToken,
			getSession: this.getSession,
			codeModeApiRequest: this.codeModeApiRequest,
		})
		this.workers.set(key, worker)
		this.lastWorker = worker
		try {
			await worker.ready
		} catch (err) {
			this.removeWorker(key, worker, { clearLastWorker: true })
			throw err
		}
		worker.touch()
		this.scheduleWorkerIdleCheck(key, worker)
		return worker
	}

	rememberToolProcessSession(key, name, args, result) {
		const now = Date.now()
		const runningId = result?.details?.running === true ? processSessionId(result?.details?.session_id) : undefined
		if (runningId) this.knownProcessSessions.set(workerProcessSessionKey(key, runningId), now)
		const requestedId = processSessionId(args?.session_id)
		if (requestedId) {
			if (result?.details?.running === true) this.knownProcessSessions.set(workerProcessSessionKey(key, requestedId), now)
			else this.knownProcessSessions.delete(workerProcessSessionKey(key, requestedId))
		}
		if ((name === "write_stdin" || name === "exec_command") && result?.details?.running === false && requestedId) {
			this.knownProcessSessions.delete(workerProcessSessionKey(key, requestedId))
		}
	}

	forgetExpiredKnownProcessSessions(now = Date.now()) {
		const ttlMs = PROCESS_SESSION_IDLE_TTL_MS + PROCESS_SESSION_BACKGROUND_GRACE_MS
		for (const [key, lastSeenAt] of this.knownProcessSessions.entries()) {
			if (now - lastSeenAt > ttlMs) this.knownProcessSessions.delete(key)
		}
	}

	forgetExpiredKnownPreviewProcesses(now = Date.now()) {
		const ttlMs = 24 * 60 * 60 * 1000
		for (const [key, lastSeenAt] of this.knownPreviewProcesses.entries()) {
			if (now - lastSeenAt > ttlMs) this.knownPreviewProcesses.delete(key)
		}
		for (const [id, preview] of this.containerPreviewProcesses.entries()) {
			if (now - preview.lastSeenAt > ttlMs) {
				preview.preview.stop?.()
				this.containerPreviewProcesses.delete(id)
			}
		}
	}

	hasBackgroundWork(now = Date.now()) {
		this.forgetExpiredKnownProcessSessions(now)
		this.forgetExpiredKnownPreviewProcesses(now)
		if (this.knownProcessSessions.size > 0) return true
		if (this.knownPreviewProcesses.size > 0) return true
		if (this.containerPreviewProcesses.size > 0) return true
		return [...this.workers.values()].some((worker) => !worker.dead && worker.hasActiveRequests())
	}

	/**
	 * @param {string} name
	 * @param {string} id
	 * @param {any} args
	 * @param {AbortSignal | undefined} signal
	 * @param {(update: any) => void} [onUpdate]
	 * @param {{ scope?: any, toolProfile?: "default" | "codex" }} [options]
	 */
	async executeTool(name, id, args, signal, onUpdate, options = {}) {
		if (this.disposed) throw new Error("Tool executor is not running")
		const target = this.resolveTarget()
		const key = this.workerKey(target)
		const worker = await this.workerFor(target, key)
		this.clearWorkerIdleTimer(key)
		try {
			const result = await worker.executeTool(name, id, args, target.cwd, signal, onUpdate, {
				scope: options.scope,
				environmentId: target.environmentId,
				toolProfile: options.toolProfile,
			})
			this.rememberToolProcessSession(key, name, args, result)
			return result
		} finally {
			if (!this.disposed && this.workers.get(key) === worker && !worker.dead) this.scheduleWorkerIdleCheck(key, worker)
		}
	}

	async startCodeModeCell(params, callbacks) {
		if (this.disposed) throw new Error("Tool executor is not running")
		const target = this.resolveTarget()
		const key = this.workerKey(target)
		const worker = await this.workerFor(target, key)
		this.clearWorkerIdleTimer(key)
		const scheduleIdleCheck = () => {
			if (!this.disposed && this.workers.get(key) === worker && !worker.dead) this.scheduleWorkerIdleCheck(key, worker)
		}
		let workerHandle
		try {
			workerHandle = await worker.startCodeModeCell(params, {
				onToolCall: callbacks.onToolCall,
				onEvent: (method, eventParams) => {
					try {
						callbacks.onEvent(method, eventParams)
					} finally {
						if (method === "complete") scheduleIdleCheck()
					}
				},
				onFailure: (error) => {
					try {
						callbacks.onFailure(error)
					} finally {
						scheduleIdleCheck()
					}
				},
			})
		} catch (error) {
			scheduleIdleCheck()
			throw error
		}
		let closed = false
		return {
			id: workerHandle.id,
			environmentId: target.environmentId,
			resetOutput: () => workerHandle.resetOutput(),
			terminate: () => {
				workerHandle.terminate()
				scheduleIdleCheck()
			},
			close: () => {
				if (closed) return
				closed = true
				workerHandle.close()
				scheduleIdleCheck()
			},
			executeTool: async (name, id, args, signal, onUpdate, options = {}) => {
				this.clearWorkerIdleTimer(key)
				try {
					const result = await worker.executeTool(name, id, args, target.cwd, signal, onUpdate, {
						scope: options.scope,
						environmentId: target.environmentId,
						toolProfile: options.toolProfile,
					})
					this.rememberToolProcessSession(key, name, args, result)
					return result
				} finally {
					scheduleIdleCheck()
				}
			},
		}
	}

	assertPreviewTargetSupported(target) {
		if (target.target?.type !== "local") {
			throw Object.assign(new Error("Session previews currently require a local worker environment"), { status: 501 })
		}
		if (target.sandbox?.type === "container" && target.sandbox?.container) {
			throw Object.assign(new Error("Session previews require a Cerex-managed container, local, or native worker environment"), { status: 501 })
		}
	}

	async startManagedContainerPreview(id, params, target) {
		const existing = this.containerPreviewProcesses.get(id)
		if (existing) {
			this.containerPreviewProcesses.delete(id)
			await existing.preview.stop?.()
		}
		const preview = await this.managedContainerPreviewFactory({
			...params,
			id,
			baseCwd: target.cwd,
			sessionWd: target.sessionWd,
			sessionDir: target.sessionDir,
			sessionId: target.sessionId,
			environmentId: target.environmentId,
			sandbox: target.sandbox,
			stateMount: target.stateMount,
		})
		this.containerPreviewProcesses.set(id, {
			preview,
			lastSeenAt: Date.now(),
		})
		return preview.inspect()
	}

	async startPreviewProcess(id, params) {
		if (this.disposed) throw new Error("Tool executor is not running")
		const target = this.resolveTarget()
		this.assertPreviewTargetSupported(target)
		if (target.sandbox?.type === "container") return await this.startManagedContainerPreview(id, params, target)
		const key = this.workerKey(target)
		const worker = await this.workerFor(target, key)
		this.clearWorkerIdleTimer(key)
		try {
			const result = await worker.startPreviewProcess({
				...params,
				id,
				baseCwd: target.cwd,
			})
			if (result?.running !== false) this.knownPreviewProcesses.set(workerPreviewProcessKey(key, id), Date.now())
			return result
		} finally {
			if (!this.disposed && this.workers.get(key) === worker && !worker.dead) this.scheduleWorkerIdleCheck(key, worker)
		}
	}

	async touchPreviewProcess(id) {
		const containerPreview = this.containerPreviewProcesses.get(id)
		if (containerPreview) {
			const result = await containerPreview.preview.touch()
			if (result?.preview?.running === false) {
				this.containerPreviewProcesses.delete(id)
				await containerPreview.preview.stop?.()
			} else {
				containerPreview.lastSeenAt = Date.now()
			}
			return result
		}
		for (const [key, worker] of this.workers.entries()) {
			const previewKey = workerPreviewProcessKey(key, id)
			if (!this.knownPreviewProcesses.has(previewKey) || worker.dead) continue
			const result = await worker.touchPreviewProcess(id)
			if (result?.ok) this.knownPreviewProcesses.set(previewKey, Date.now())
			return result
		}
		return { ok: false }
	}

	async stopPreviewProcess(id) {
		let stopped = false
		const containerPreview = this.containerPreviewProcesses.get(id)
		if (containerPreview) {
			this.containerPreviewProcesses.delete(id)
			const result = await containerPreview.preview.stop()
			stopped = result?.ok !== false
		}
		for (const [key, worker] of this.workers.entries()) {
			const previewKey = workerPreviewProcessKey(key, id)
			if (!this.knownPreviewProcesses.has(previewKey)) continue
			this.knownPreviewProcesses.delete(previewKey)
			if (!worker.dead) {
				await worker.stopPreviewProcess(id).catch(() => ({ ok: false }))
				stopped = true
			}
		}
		return { ok: stopped }
	}

	async inspect(options = {}) {
		const workers = []
		for (const [key, worker] of this.workers.entries()) workers.push(await worker.inspect(key, options))
		this.forgetExpiredKnownProcessSessions()
		this.forgetExpiredKnownPreviewProcesses()
		return {
			disposed: this.disposed,
			workerCount: this.workers.size,
			idleWorkerTtlMs: this.idleWorkerTtlMs,
			knownProcessSessionCount: this.knownProcessSessions.size,
			knownPreviewProcessCount: this.knownPreviewProcesses.size,
			containerPreviewProcessCount: this.containerPreviewProcesses.size,
			backgroundWork: this.hasBackgroundWork(),
			workers,
		}
	}

	dispose() {
		this.disposed = true
		for (const key of this.idleWorkerTimers.keys()) this.clearWorkerIdleTimer(key)
		this.knownProcessSessions.clear()
		this.knownPreviewProcesses.clear()
		for (const { preview } of this.containerPreviewProcesses.values()) preview.stop?.()
		this.containerPreviewProcesses.clear()
		for (const worker of this.workers.values()) worker.dispose()
		this.workers.clear()
		this.lastWorker = undefined
	}
}
