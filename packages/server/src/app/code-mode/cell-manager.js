import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { JsonLineRpc } from "../json-rpc-lines.js"

const NODE_RUNNER_PATH = fileURLToPath(new URL("./runner.mjs", import.meta.url))
const QN_RUNNER_PATH = fileURLToPath(new URL("./runner-qn.mjs", import.meta.url))
const RUNNER_COMMON_PATH = fileURLToPath(new URL("./runner-common.mjs", import.meta.url))
const STDERR_LIMIT = 8 * 1024
const RUNTIME = process.versions?.quickjs ? "qn" : "node"

let permissionFlag

function minimalChildEnvironment() {
	return Object.fromEntries([
		["PATH", process.env.PATH],
		["SystemRoot", process.env.SystemRoot],
		["WINDIR", process.env.WINDIR],
	].filter(([, value]) => typeof value === "string" && value))
}

function nodePermissionFlag() {
	if (permissionFlag) return permissionFlag
	const env = minimalChildEnvironment()
	const stable = spawnSync(process.execPath, ["--permission", "--version"], { env, encoding: "utf8" })
	if (stable.status === 0) {
		permissionFlag = "--permission"
		return permissionFlag
	}
	const experimental = spawnSync(process.execPath, ["--experimental-permission", "--version"], { env, encoding: "utf8" })
	if (experimental.status === 0) {
		permissionFlag = "--experimental-permission"
		return permissionFlag
	}
	const detail = [stable, experimental]
		.map((result) => result.error?.message || result.stderr?.trim() || `exit status ${result.status ?? "unknown"}`)
		.join("; ")
	throw new Error(`Code mode requires a Node.js runtime with the permission model enabled: ${detail}`)
}

function runnerCommand() {
	if (RUNTIME === "qn") {
		return {
			command: process.execPath,
			args: [QN_RUNNER_PATH],
		}
	}
	return {
		command: process.execPath,
		args: [
			nodePermissionFlag(),
			`--allow-fs-read=${NODE_RUNNER_PATH}`,
			`--allow-fs-read=${RUNNER_COMMON_PATH}`,
			NODE_RUNNER_PATH,
		],
	}
}

function killChild(child) {
	if (child && child.exitCode === null && child.signalCode === null) {
		try {
			child.kill("SIGKILL")
		} catch {}
	}
}

function errorText(error) {
	return error instanceof Error ? error.stack || error.message : String(error)
}

/** Owns code-mode runner children inside a tool worker. The surrounding worker process is already inside the selected tool sandbox; the runner is a separate child so synchronous model code cannot block worker RPC. */
export class CodeModeCellManager {
	/**
	 * @param {object} options
	 * @param {(id: string, request: any) => Promise<any>} options.onToolCall
	 * @param {(id: string, method: string, params: any) => void} options.onEvent
	 * @param {(id: string, error: Error) => void} options.onFailure
	 */
	constructor(options) {
		this.onToolCall = options.onToolCall
		this.onEvent = options.onEvent
		this.onFailure = options.onFailure
		/** @type {Map<string, any>} */
		this.cells = new Map()
		this.disposed = false
	}

	async start(params) {
		if (this.disposed) throw new Error("Code-mode cell manager is disposed")
		if (!params || typeof params.id !== "string" || !params.id) throw new Error("Code-mode cell id is required")
		if (typeof params.code !== "string") throw new Error("Code-mode cell source is required")
		if (this.cells.has(params.id)) throw new Error(`Code-mode cell ${params.id} already exists`)

		const runner = runnerCommand()
		const child = spawn(runner.command, runner.args, {
			env: minimalChildEnvironment(),
			stdio: ["pipe", "pipe", "pipe"],
		})
		const cell = {
			id: params.id,
			child,
			rpc: undefined,
			status: "starting",
			runtime: RUNTIME,
			startedAt: Date.now(),
			stderr: "",
		}
		this.cells.set(cell.id, cell)

		cell.rpc = new JsonLineRpc({
			input: child.stdout,
			output: child.stdin,
			onRequest: (method, request) => {
				if (method !== "tool_call") throw new Error(`Unknown code-mode runner request: ${method}`)
				return this.onToolCall(cell.id, request)
			},
			onNotification: (method, eventParams) => this.handleRunnerEvent(cell, method, eventParams),
			onProtocolError: (error) => this.fail(cell, error),
			onClose: () => this.handleRunnerClose(cell),
		})
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk) => {
			cell.stderr = `${cell.stderr}${chunk}`.slice(-STDERR_LIMIT)
		})

		try {
			await new Promise((resolve, reject) => {
				const spawned = () => {
					child.removeListener("error", failed)
					resolve()
				}
				const failed = (error) => {
					child.removeListener("spawn", spawned)
					reject(error)
				}
				child.once("spawn", spawned)
				child.once("error", failed)
			})
		} catch (error) {
			this.cells.delete(cell.id)
			cell.status = "failed"
			cell.rpc.close()
			killChild(child)
			throw error
		}

		if (this.disposed || this.cells.get(cell.id) !== cell) {
			killChild(child)
			throw new Error("Code-mode cell manager was disposed during startup")
		}
		cell.status = "running"
		child.on("error", (error) => this.fail(cell, error))
		child.on("close", () => this.handleRunnerClose(cell))
		setImmediate(() => {
			if (cell.status !== "running") return
			cell.rpc.notify("start", {
				code: params.code,
				tools: params.tools,
				storedValues: params.storedValues,
				maxOutputChars: params.maxOutputChars,
			})
		})
		return { id: cell.id }
	}

	handleRunnerEvent(cell, method, params) {
		if (cell.status !== "running") return
		if (method === "complete") {
			cell.status = "completed"
			this.cells.delete(cell.id)
			try {
				this.onEvent(cell.id, method, params)
			} finally {
				killChild(cell.child)
			}
			return
		}
		if (!["output", "store", "yield"].includes(method)) {
			this.fail(cell, new Error(`Unknown code-mode runner event: ${method}`))
			return
		}
		this.onEvent(cell.id, method, params)
	}

	handleRunnerClose(cell) {
		if (cell.status !== "starting" && cell.status !== "running") return
		const detail = cell.stderr.trim()
		this.fail(cell, new Error(detail ? `Code-mode runner exited unexpectedly:\n${detail}` : "Code-mode runner exited unexpectedly"))
	}

	fail(cell, error) {
		if (cell.status !== "starting" && cell.status !== "running") return
		cell.status = "failed"
		this.cells.delete(cell.id)
		try {
			this.onFailure(cell.id, error instanceof Error ? error : new Error(errorText(error)))
		} finally {
			killChild(cell.child)
		}
	}

	resetOutput(id) {
		this.cells.get(id)?.rpc?.notify("reset_output")
	}

	terminate(id) {
		const cell = this.cells.get(id)
		if (!cell) return false
		cell.status = "terminated"
		this.cells.delete(id)
		cell.rpc?.notify("terminate")
		killChild(cell.child)
		return true
	}

	inspect(now = Date.now()) {
		return {
			cellCount: this.cells.size,
			cells: [...this.cells.values()].map((cell) => ({
				id: cell.id,
				status: cell.status,
				runtime: cell.runtime,
				pid: cell.child.pid,
				ageMs: now - cell.startedAt,
			})),
		}
	}

	dispose() {
		if (this.disposed) return
		this.disposed = true
		for (const id of [...this.cells.keys()]) this.terminate(id)
	}
}
