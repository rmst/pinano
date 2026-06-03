#!/usr/bin/env node

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { createDefaultTools } from "../tools/index.js"
import { JsonLineRpc } from "./json-rpc-lines.js"
import { WORKER_PROTOCOL_VERSION, assertWorkerProtocolVersion } from "./worker-protocol.js"

let cwd = process.cwd()
/** @type {Map<string, AbortController>} */
const activeTools = new Map()
let shuttingDown = false

function registerPidFile() {
	const pidFile = process.env.PINANO_WORKER_PID_FILE
	if (!pidFile) return
	try {
		mkdirSync(dirname(pidFile), { recursive: true })
		writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
		process.on("exit", () => {
			try {
				unlinkSync(pidFile)
			} catch {}
		})
	} catch (err) {
		console.error(`failed to register Pinano worker pid file: ${err?.message ?? err}`)
		process.exit(1)
	}
}

function shutdown() {
	if (shuttingDown) return
	shuttingDown = true
	for (const controller of activeTools.values()) controller.abort()
	setTimeout(() => process.exit(0), 50)
}

registerPidFile()

/** @param {any} tool */
function serializableTool(tool) {
	const { execute: _execute, ...rest } = tool
	return rest
}

/** @param {any} _scope @param {string} toolCwd @param {{ toolProfile?: "default" | "codex" }} [options] */
function toolsForScope(_scope, toolCwd = cwd, options = {}) {
	return createDefaultTools(toolCwd, {
		beforeFileMutation: (info) => rpc.request("beforeFileMutation", info),
		toolProfile: options.toolProfile,
	})
}

async function executeTool(params) {
	const controller = new AbortController()
	activeTools.set(params.id, controller)
	try {
		const tool = toolsForScope(params.scope, params.cwd ?? cwd, { toolProfile: params.toolProfile })
			.find((item) => item.name === params.name)
		if (!tool) throw new Error(`Tool not found: ${params.name}`)
		return await tool.execute(params.id, params.args, controller.signal, (update) => {
			rpc.notify("toolUpdate", { id: params.id, update })
		})
	} finally {
		activeTools.delete(params.id)
	}
}

const rpc = new JsonLineRpc({
	input: process.stdin,
	output: process.stdout,
	rejectPendingOnClose: false,
	onRequest: async (method, params = {}) => {
		if (method === "init") {
			assertWorkerProtocolVersion(params.protocolVersion)
			cwd = params.cwd ?? process.env.HOME ?? cwd
			return {
				protocolVersion: WORKER_PROTOCOL_VERSION,
				cwd,
				tools: toolsForScope(undefined).map(serializableTool),
			}
		}
		if (method === "executeTool") return executeTool(params)
		if (method === "cancelTool") {
			activeTools.get(params.id)?.abort()
			return { ok: true }
		}
		throw new Error(`Unknown tool worker method: ${method}`)
	},
	onProtocolError: (err) => {
		console.error(err?.stack ?? err)
	},
	onClose: shutdown,
})

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
