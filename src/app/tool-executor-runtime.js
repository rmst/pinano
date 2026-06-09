import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { markUncertainToolExecution } from "../agent-core/tool-errors.js"
import { resolveExecutionEnvironment, resolveSessionWd } from "./environments.js"
import { recordFileCheckpoint } from "./file-checkpoints.js"
import { JsonLineRpc } from "./json-rpc-lines.js"
import { optionalSessionWorkspacePath } from "./paths.js"
import { pinanoStateMountFromSettings } from "./settings.js"
import { sandboxWithSessionMounts, sessionSandboxBaseWd, sessionSandboxMounts } from "./session-config.js"
import { getEffectiveSessionProperties } from "./session-properties.js"
import { createWorkerLauncher } from "./worker-launchers.js"
import { WORKER_PROTOCOL_VERSION, assertWorkerProtocolVersion } from "./worker-protocol.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultToolWorkerPath = join(here, "tool-worker.js")
const DEFAULT_WORKER_INSPECT_TIMEOUT_MS = 500

function sandboxBaseWdForSession(session, fallbackCwd) {
	const config = session?.getSessionConfig?.() ?? {}
	return sessionSandboxBaseWd(config, session?.getMetadata?.()?.cwd ?? fallbackCwd)
}

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

function shortHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12)
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
	 * @param {any} options.launcher
	 * @param {string} options.workerPath
	 * @param {() => import("../session-manager/session.js").Session | null | undefined} options.getSession
	 * @param {(request: any) => Promise<any>} [options.pinanoApiRequest]
	 */
	constructor(options) {
		this.environmentId = options.environmentId
		this.target = options.target
		this.sandbox = options.sandbox
		this.startCwd = options.startCwd
		this.sessionWd = options.sessionWd
		this.sessionDir = options.sessionDir
		this.launcher = options.launcher
		this.workerPath = options.workerPath
		this.getSession = options.getSession
		this.pinanoApiRequest = options.pinanoApiRequest
		this.workerHandle = undefined
		this.child = undefined
		this.rpc = undefined
		this.dead = false
		this.workerStderr = ""
		this.pendingToolUpdates = new Map()
		this.exitPromise = Promise.resolve(undefined)
		this.ready = this.startWorker()
			.then(() => {
				if (this.dead) throw new Error("Tool executor was disposed before init")
				return this.initWorker({ protocolVersion: WORKER_PROTOCOL_VERSION, cwd: this.startCwd })
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
		const handle = await this.launcher.start({ cwd: this.startCwd, sessionWd: this.sessionWd, sessionDir: this.sessionDir, environmentId: this.environmentId, workerPath: this.workerPath })
		if (this.dead) {
			handle.stop?.()
			throw new Error("Tool executor was disposed before startup completed")
		}
		this.workerHandle = handle
		this.child = handle.child
		this.child.stderr?.on("data", (chunk) => {
			this.workerStderr += chunk.toString()
			if (this.workerStderr.length > 8000) this.workerStderr = this.workerStderr.slice(-8000)
			process.stderr.write(`[pinano-tool-worker:${this.environmentId}] ${chunk}`)
		})
		this.rpc = new JsonLineRpc({
			input: this.child.stdout,
			output: this.child.stdin,
			rejectPendingOnClose: false,
			onRequest: (method, params) => this.handleWorkerRequest(method, params),
			onNotification: (method, params) => this.handleWorkerNotification(method, params),
			onProtocolError: (err) => process.stderr.write(`[pinano-tool-worker:${this.environmentId}] ${err.stack || err}\n`),
		})
		this.exitPromise = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => {
				this.dead = true
				this.pendingToolUpdates.clear()
				resolve({ code, signal })
			})
		})
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
		try {
			await this.ready
		} catch (error) {
			throw error
		}
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
	}

	async handleWorkerRequest(method, params = {}) {
		if (method === "beforeFileMutation") {
			return recordFileCheckpoint(this.getSession(), params.absolutePath)
		}
		if (method === "pinanoApi") {
			if (!this.pinanoApiRequest) throw new Error("Pinano JS API is unavailable for this session")
			return this.pinanoApiRequest(params)
		}
		if (method === "internalHttp") {
			if (!this.pinanoApiRequest) throw new Error("Pinano internal API is unavailable for this session")
			return this.pinanoApiRequest({
				op: "internalHttp",
				request: params,
				workerContext: {
					environmentId: this.environmentId,
					target: this.target,
					sandbox: this.sandbox,
					startCwd: this.startCwd,
					sessionWd: this.sessionWd,
					sessionDir: this.sessionDir,
				},
			})
		}
		throw new Error(`Unknown tool worker request: ${method}`)
	}

	handleWorkerNotification(method, params = {}) {
		if (method === "toolUpdate") {
			this.pendingToolUpdates.get(params.id)?.(params.update)
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
			pendingToolUpdateCount: this.pendingToolUpdates.size,
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
		this.dead = true
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
	 * @param {() => import("../session-manager/session.js").Session | null | undefined} [options.getSession]
	 * @param {(request: any) => Promise<any>} [options.pinanoApiRequest]
	 * @param {() => any} [options.environmentRegistry]
	 * @param {() => any} [options.getSettings]
	 */
	constructor(options) {
		this.cwd = options.cwd
		this.getSession = options.getSession ?? (() => undefined)
		this.pinanoApiRequest = options.pinanoApiRequest
		this.fixedWorkerLauncher = options.workerLauncher
		this.workerPath = options.workerPath ?? defaultToolWorkerPath
		this.environmentRegistry = options.environmentRegistry
		this.getSettings = options.getSettings
		this.workers = new Map()
		this.startCwds = new Map()
		this.disposed = false
		this.lastWorker = undefined
		this.ready = Promise.resolve()
			.then(() => this.workerFor(this.resolveTarget()))
			.then(() => this)
		this.ready.catch(() => {})
	}

	get child() {
		return this.lastWorker?.child
	}

	get exitPromise() {
		return this.lastWorker?.exitPromise ?? Promise.resolve(undefined)
	}

	get isDead() {
		return this.disposed || this.lastWorker?.dead === true
	}

	resolveTarget() {
		const registry = this.environmentRegistry?.()
		const session = this.getSession()
		const props = session ? getEffectiveSessionProperties(session) : undefined
		const target = resolveExecutionEnvironment(props, this.cwd, registry)
		const config = session?.getSessionConfig?.() ?? {}
		const sandbox = sandboxWithSessionMounts(target.sandbox, sessionSandboxMounts(config))
		const sessionWd = resolveSessionWd(props, sandboxBaseWdForSession(session, this.cwd), registry)
		const sessionId = session?.getMetadata?.()?.id
		const sessionDir = target.target?.type === "local" ? optionalSessionWorkspacePath(sessionId) : undefined
		const pinanoStateMount = pinanoStateMountFromSettings(this.getSettings?.())
		return { ...target, sandbox, sessionWd, sessionDir, pinanoStateMount, workerScope: sessionId ? `session:${sessionId}` : "runtime" }
	}

	async workerFor(target) {
		const key = `${target.workerScope}\0${target.environmentId}\0${JSON.stringify(target.target)}\0${JSON.stringify(target.sandbox)}\0${target.pinanoStateMount || false}`
		let startCwd = target.cwd
		if (target.sandbox?.type && target.sandbox.type !== "none") {
			if (!this.startCwds.has(key)) this.startCwds.set(key, target.sandbox?.useSessionWd === false ? undefined : target.sessionWd ?? target.cwd)
			startCwd = this.startCwds.get(key)
		}
		const existing = this.workers.get(key)
		if (existing && !existing.dead) {
			this.lastWorker = existing
			return existing
		}
		if (existing) {
			existing.dispose()
			this.workers.delete(key)
		}
		const worker = new ToolWorkerConnection({
			environmentId: target.environmentId,
			target: target.target,
			sandbox: target.sandbox,
			startCwd,
			sessionWd: target.sessionWd,
			sessionDir: target.sessionDir,
			launcher: this.fixedWorkerLauncher ?? createWorkerLauncher({ target: target.target, sandbox: target.sandbox, pinanoStateMount: target.pinanoStateMount }),
			workerPath: this.workerPath,
			getSession: this.getSession,
			pinanoApiRequest: this.pinanoApiRequest,
		})
		this.workers.set(key, worker)
		this.lastWorker = worker
		await worker.ready
		return worker
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
		const worker = await this.workerFor(target)
		return worker.executeTool(name, id, args, target.cwd, signal, onUpdate, {
			scope: options.scope,
			environmentId: target.environmentId,
			toolProfile: options.toolProfile,
		})
	}

	async inspect(options = {}) {
		const workers = []
		for (const [key, worker] of this.workers.entries()) workers.push(await worker.inspect(key, options))
		return {
			disposed: this.disposed,
			workerCount: this.workers.size,
			workers,
		}
	}

	dispose() {
		this.disposed = true
		for (const worker of this.workers.values()) worker.dispose()
		this.workers.clear()
	}
}
