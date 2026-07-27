import { spawn } from "node:child_process"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyProcessTitleRole } from "./process-title.js"

export const REEXEC_REQUEST_EXIT_CODE = 113
export const STALE_RUNTIME_REEXEC_DEPTH_ENV = "CEREX_STALE_RUNTIME_REEXEC_DEPTH"
export const REEXEC_REQUEST_FILE_ENV = "CEREX_REEXEC_REQUEST_FILE"
export const REEXEC_SUPERVISOR_PID_ENV = "CEREX_REEXEC_SUPERVISOR_PID"

const STALE_RUNTIME_REEXEC_MAX_DEPTH = 3
const REEXEC_REQUEST_VERSION = 1
const REEXEC_SUPERVISOR_ENV_KEYS = [
	REEXEC_REQUEST_FILE_ENV,
	REEXEC_SUPERVISOR_PID_ENV,
]
const SUPERVISOR_FORWARDED_SIGNALS = ["SIGHUP", "SIGTERM"]
const inheritedSupervisorTarget = {
	requestFile: process.env[REEXEC_REQUEST_FILE_ENV],
	supervisorPid: process.env[REEXEC_SUPERVISOR_PID_ENV],
}

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

export function withoutReexecSupervisorEnv(env = process.env) {
	const next = { ...env }
	for (const key of REEXEC_SUPERVISOR_ENV_KEYS) delete next[key]
	return next
}

export function clearReexecSupervisorEnv(env = process.env) {
	for (const key of REEXEC_SUPERVISOR_ENV_KEYS) delete env[key]
}

function supervisorEnv(env, requestFile) {
	return {
		...env,
		[REEXEC_REQUEST_FILE_ENV]: requestFile,
		[REEXEC_SUPERVISOR_PID_ENV]: String(process.pid),
	}
}

function supervisorTarget(env) {
	const requestFile = env[REEXEC_REQUEST_FILE_ENV]
	const supervisorPid = env[REEXEC_SUPERVISOR_PID_ENV]
	if (typeof requestFile === "string" && requestFile && typeof supervisorPid === "string") return { requestFile, supervisorPid }
	if (env === process.env && !requestFile && !supervisorPid && inheritedSupervisorTarget.requestFile && inheritedSupervisorTarget.supervisorPid) return inheritedSupervisorTarget
	return null
}

function validSupervisorTarget(target) {
	const supervisorPid = Number(target?.supervisorPid)
	return typeof target?.requestFile === "string" && target.requestFile && processExists(supervisorPid) && supervisorPid !== process.pid
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

function normalizeEnvPatch(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {}
	return Object.fromEntries(Object.entries(value).filter(([, patchValue]) =>
		patchValue === null
		|| patchValue === undefined
		|| ["string", "number", "boolean"].includes(typeof patchValue)
	))
}

async function readRequest(path) {
	const parsed = JSON.parse(await readFile(path, "utf-8"))
	const command = typeof parsed.command === "string" && parsed.command ? parsed.command : null
	const args = normalizeStringArray(parsed.args)
	const cwd = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined
	const envPatch = normalizeEnvPatch(parsed.envPatch)
	if (!command || !args) throw new Error("Invalid Cerex reexec request")
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

function signalExitCode(signal) {
	if (signal === "SIGHUP") return 129
	if (signal === "SIGTERM") return 143
	return 1
}

function installSignalForwarding(currentChild) {
	const listeners = SUPERVISOR_FORWARDED_SIGNALS.map((signal) => {
		const listener = () => {
			const child = currentChild()
			if (child?.pid) child.kill(signal)
			else process.exit(signalExitCode(signal))
		}
		process.on(signal, listener)
		return [signal, listener]
	})
	return () => {
		for (const [signal, listener] of listeners) process.removeListener(signal, listener)
	}
}

async function exitLikeChild(dir, exit) {
	await rm(dir, { recursive: true, force: true }).catch(() => {})
	if (exit.signal) {
		process.kill(process.pid, exit.signal)
		process.exit(1)
	}
	process.exit(exit.code ?? 0)
}

/**
 * Run a small foreground supervisor that owns restart requests for one interactive Cerex client.
 * @param {{ command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, envPatch?: Record<string, string | number | boolean | null | undefined> }} options
 */
export async function runReexecSupervisor(options) {
	const baseEnv = options.env ?? process.env
	applyProcessTitleRole("supervisor", { env: baseEnv })
	const dir = await mkdtemp(join(tmpdir(), "reexec-"))
	const requestFile = join(dir, "request.json")
	let command = options.command
	let args = options.args
	let cwd = options.cwd
	let env = supervisorEnv(applyEnvPatch(baseEnv, options.envPatch), requestFile)
	let child = null
	const stopSignalForwarding = installSignalForwarding(() => child)

	try {
		for (;;) {
			await rm(requestFile, { force: true }).catch(() => {})
			child = spawn(command, args, { cwd, env, stdio: "inherit" })
			const exit = await waitForChild(child)
			child = null
			if (!exit.signal && exit.code === REEXEC_REQUEST_EXIT_CODE) {
				const request = await readRequest(requestFile)
				await rm(requestFile, { force: true }).catch(() => {})
				command = request.command
				args = request.args
				cwd = request.cwd ?? cwd
				env = supervisorEnv(applyEnvPatch(env, request.envPatch), requestFile)
				continue
			}
			stopSignalForwarding()
			await exitLikeChild(dir, exit)
		}
	} catch (err) {
		stopSignalForwarding()
		await rm(dir, { recursive: true, force: true }).catch(() => {})
		throw err
	}
}

/**
 * Reopen the current Cerex runtime without building a stale parent chain. Launcher-owned supervisors are preferred; direct runtime invocations fall back to supervision inside the stale process.
 * @param {{ command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, envPatch?: Record<string, string | number | boolean | null | undefined> }} options
 */
export async function reexecRuntime(options) {
	const env = options.env ?? process.env
	const target = supervisorTarget(env)
	if (validSupervisorTarget(target)) {
		await writeRequest(target.requestFile, {
			version: REEXEC_REQUEST_VERSION,
			command: options.command,
			args: options.args,
			cwd: options.cwd,
			envPatch: normalizeEnvPatch(options.envPatch),
		})
		process.exit(REEXEC_REQUEST_EXIT_CODE)
	}
	await runReexecSupervisor({
		command: options.command,
		args: options.args,
		cwd: options.cwd,
		env,
		envPatch: options.envPatch ?? {},
	})
	return true
}
