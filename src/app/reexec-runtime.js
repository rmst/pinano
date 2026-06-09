import { spawn } from "node:child_process"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const REEXEC_REQUEST_EXIT_CODE = 113
export const STALE_RUNTIME_REEXEC_DEPTH_ENV = "PINANO_STALE_RUNTIME_REEXEC_DEPTH"

const REQUEST_FILE_ENV = "PINANO_REEXEC_REQUEST_FILE"
const SUPERVISOR_PID_ENV = "PINANO_REEXEC_SUPERVISOR_PID"
const STALE_RUNTIME_REEXEC_MAX_DEPTH = 3

export function nextStaleRuntimeReexecDepth(env = process.env) {
	const depth = Number(env[STALE_RUNTIME_REEXEC_DEPTH_ENV] ?? 0)
	if (Number.isFinite(depth) && depth >= STALE_RUNTIME_REEXEC_MAX_DEPTH) throw new Error("stale runtime reexec depth exceeded")
	return String((Number.isFinite(depth) ? depth : 0) + 1)
}

export function staleRuntimeReexecEnvPatch(env = process.env) {
	return { [STALE_RUNTIME_REEXEC_DEPTH_ENV]: nextStaleRuntimeReexecDepth(env) }
}

export function clearStaleRuntimeReexecDepth(env = process.env) {
	delete env[STALE_RUNTIME_REEXEC_DEPTH_ENV]
}

function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return err?.code === "EPERM"
	}
}

function applyEnvPatch(env, patch = {}) {
	const next = { ...env }
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined || value === null) delete next[key]
		else next[key] = String(value)
	}
	return next
}

function supervisorEnv(env, requestFile) {
	return {
		...env,
		[REQUEST_FILE_ENV]: requestFile,
		[SUPERVISOR_PID_ENV]: String(process.pid),
	}
}

function canRequestSupervisor(env) {
	const requestFile = env[REQUEST_FILE_ENV]
	const supervisorPid = Number(env[SUPERVISOR_PID_ENV])
	return typeof requestFile === "string" && requestFile && processExists(supervisorPid) && supervisorPid !== process.pid
}

async function writeRequest(path, request) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(request, null, "\t"), { mode: 0o600 })
	await rename(tmp, path)
}

function normalizeStringArray(value) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null
	return value
}

async function readRequest(path) {
	const parsed = JSON.parse(await readFile(path, "utf-8"))
	const command = typeof parsed.command === "string" && parsed.command ? parsed.command : null
	const args = normalizeStringArray(parsed.args)
	const cwd = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined
	const envPatch = parsed.envPatch && typeof parsed.envPatch === "object" && !Array.isArray(parsed.envPatch) ? parsed.envPatch : {}
	if (!command || !args) throw new Error("Invalid Pinano reexec request")
	return { command, args, cwd, envPatch }
}

function waitForChild(child) {
	return new Promise((resolve, reject) => {
		let settled = false
		child.on("error", (err) => {
			if (settled) return
			settled = true
			reject(err)
		})
		child.on("exit", (code, signal) => {
			if (settled) return
			settled = true
			resolve({ code, signal })
		})
	})
}

async function exitLikeChild(dir, exit) {
	await rm(dir, { recursive: true, force: true }).catch(() => {})
	if (exit.signal) {
		process.kill(process.pid, exit.signal)
		process.exit(1)
	}
	process.exit(exit.code ?? 0)
}

async function runSupervisor(options) {
	const dir = await mkdtemp(join(tmpdir(), "pinano-reexec-"))
	const requestFile = join(dir, "request.json")
	let command = options.command
	let args = options.args
	let cwd = options.cwd
	let env = supervisorEnv(applyEnvPatch(options.env, options.envPatch), requestFile)

	try {
		for (;;) {
			const child = spawn(command, args, { cwd, env, stdio: "inherit" })
			const exit = await waitForChild(child)
			if (!exit.signal && exit.code === REEXEC_REQUEST_EXIT_CODE) {
				const request = await readRequest(requestFile)
				await rm(requestFile, { force: true }).catch(() => {})
				command = request.command
				args = request.args
				cwd = request.cwd ?? cwd
				env = supervisorEnv(applyEnvPatch(env, request.envPatch), requestFile)
				continue
			}
			await exitLikeChild(dir, exit)
		}
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
		throw err
	}
}

/**
 * Reopen the current Pinano runtime without building a stale parent chain. The first stale runtime becomes a one-process supervisor so the invoking shell still waits for the foreground job; later stale children request replacement through that supervisor and exit.
 * @param {{ command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, envPatch?: Record<string, string | number | boolean | null | undefined> }} options
 */
export async function reexecRuntime(options) {
	const env = options.env ?? process.env
	if (canRequestSupervisor(env)) {
		await writeRequest(env[REQUEST_FILE_ENV], {
			command: options.command,
			args: options.args,
			cwd: options.cwd,
			envPatch: options.envPatch ?? {},
		})
		process.exit(REEXEC_REQUEST_EXIT_CODE)
	}
	await runSupervisor({
		command: options.command,
		args: options.args,
		cwd: options.cwd,
		env,
		envPatch: options.envPatch ?? {},
	})
	return true
}
