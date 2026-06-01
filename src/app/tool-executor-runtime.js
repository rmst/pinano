import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { markUncertainToolExecution } from "../agent-core/tool-errors.js"
import { resolveExecutionEnvironment } from "./environments.js"
import { recordFileCheckpoint } from "./file-checkpoints.js"
import { JsonLineRpc } from "./json-rpc-lines.js"
import { getEffectiveSessionProperties } from "./session-properties.js"
import { createWorkerLauncher } from "./worker-launchers.js"
import { WORKER_PROTOCOL_VERSION, assertWorkerProtocolVersion } from "./worker-protocol.js"

const here = dirname(fileURLToPath(import.meta.url))
const defaultToolWorkerPath = join(here, "tool-worker.js")

class ToolWorkerConnection {
	/**
	 * @param {object} options
	 * @param {string} options.environmentId
	 * @param {string | undefined} options.startCwd
	 * @param {any} options.launcher
	 * @param {string} options.workerPath
	 * @param {() => import("../session-manager/session.js").Session | null | undefined} options.getSession
	 * @param {(request: any) => Promise<any>} [options.pinanoApiRequest]
	 */
	constructor(options) {
		this.environmentId = options.environmentId
		this.startCwd = options.startCwd
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
		const handle = await this.launcher.start({ cwd: this.startCwd, workerPath: this.workerPath })
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
	 * @param {{ scope?: any, environmentId?: string, toolProfile?: "default" | "apply_patch" }} [options]
	 */
	async executeTool(name, id, args, cwd, signal, onUpdate, options = {}) {
		if (this.dead) throw markUncertainToolExecution(new Error("Tool executor is not running"))
		try {
			await this.ready
		} catch (error) {
			if (error instanceof Error) throw markUncertainToolExecution(error)
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
		throw new Error(`Unknown tool worker request: ${method}`)
	}

	handleWorkerNotification(method, params = {}) {
		if (method === "toolUpdate") {
			this.pendingToolUpdates.get(params.id)?.(params.update)
			return
		}
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
	 */
	constructor(options) {
		this.cwd = options.cwd
		this.getSession = options.getSession ?? (() => undefined)
		this.pinanoApiRequest = options.pinanoApiRequest
		this.fixedWorkerLauncher = options.workerLauncher
		this.workerPath = options.workerPath ?? defaultToolWorkerPath
		this.environmentRegistry = options.environmentRegistry
		this.workers = new Map()
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
		return resolveExecutionEnvironment(props, this.cwd, registry)
	}

	async workerFor(target) {
		const key = `${target.environmentId}\0${target.worker}`
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
			startCwd: target.cwd,
			launcher: this.fixedWorkerLauncher ?? createWorkerLauncher(target.worker),
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
	 * @param {{ scope?: any, toolProfile?: "default" | "apply_patch" }} [options]
	 */
	async executeTool(name, id, args, signal, onUpdate, options = {}) {
		if (this.disposed) throw markUncertainToolExecution(new Error("Tool executor is not running"))
		const target = this.resolveTarget()
		const worker = await this.workerFor(target)
		return worker.executeTool(name, id, args, target.cwd, signal, onUpdate, {
			scope: options.scope,
			environmentId: target.environmentId,
			toolProfile: options.toolProfile,
		})
	}

	dispose() {
		this.disposed = true
		for (const worker of this.workers.values()) worker.dispose()
		this.workers.clear()
	}
}
