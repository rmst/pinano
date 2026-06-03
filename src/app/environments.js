import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

import { environmentsConfigPath } from "./paths.js"
import { configuredWorkerSpec } from "./service-config.js"
import { parseWorkerSpec } from "./worker-launchers.js"

const ENVIRONMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const DEFAULT_SANDBOX_PATHS = ["."]

function defaultLocalSandbox() {
	return process.platform === "darwin" || process.platform === "linux"
		? { type: "native" }
		: { type: "container" }
}

function readEnvironmentsConfig() {
	try {
		const parsed = JSON.parse(readFileSync(environmentsConfigPath(), "utf-8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("environments.json must contain an object")
		return parsed
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

async function readEnvironmentsConfigForWrite() {
	try {
		const parsed = JSON.parse(await readFile(environmentsConfigPath(), "utf-8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("environments.json must contain an object")
		return parsed
	} catch (err) {
		if (err?.code === "ENOENT") return {}
		throw err
	}
}

/** @param {string} id */
function validateEnvironmentId(id) {
	if (typeof id !== "string" || !ENVIRONMENT_ID_RE.test(id)) {
		throw new TypeError(`Invalid environment id: ${id}. Use 1-64 letters, numbers, _ or -, starting with a letter or number.`)
	}
	return id
}

/** @param {any} value @param {string} field */
function optionalString(value, field) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`)
	const trimmed = value.trim()
	if (!trimmed) throw new TypeError(`${field} must be a non-empty string`)
	return trimmed
}

/** @param {string} spec @param {string} id */
function parseTargetSpec(spec, id) {
	if (spec === "local") return { type: "local" }
	if (spec.startsWith("ssh:")) {
		const host = spec.slice("ssh:".length)
		if (!host || host.includes("/")) throw new TypeError(`Invalid target for environment ${id}: ${spec}`)
		return { type: "ssh", host }
	}
	throw new TypeError(`Invalid target for environment ${id}: ${spec}. Use "local" or "ssh:<target>".`)
}

/** @param {string} id @param {any} value */
function normalizeTarget(id, value) {
	const spec = optionalString(value.target ?? "local", `Environment ${id} target`)
	return parseTargetSpec(spec, id)
}

/** @param {string} id @param {any} value */
function normalizeSandboxPaths(id, value) {
	const raw = Object.prototype.hasOwnProperty.call(value, "paths") ? value.paths : DEFAULT_SANDBOX_PATHS
	if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`Environment ${id} sandbox paths must be a non-empty array`)
	return raw.map((item, index) => {
		if (typeof item !== "string") throw new TypeError(`Environment ${id} sandbox paths[${index}] must be a string`)
		const path = item.trim()
		if (!path) throw new TypeError(`Environment ${id} sandbox paths[${index}] must be a non-empty string`)
		return path
	})
}

/** @param {string} id @param {any} value @param {ReturnType<typeof normalizeTarget>} target */
function normalizeSandbox(id, value, target) {
	const raw = Object.prototype.hasOwnProperty.call(value, "sandbox")
		? value.sandbox
		: target.type === "local"
			? defaultLocalSandbox()
			: undefined
	if (raw === undefined) throw new TypeError(`Environment ${id} requires a sandbox`)
	const sandbox = typeof raw === "string" ? { type: raw } : raw
	if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) throw new TypeError(`Environment ${id} sandbox must be an object`)
	const type = optionalString(sandbox.type, `Environment ${id} sandbox type`)
	if (type === "none") {
		if (Object.prototype.hasOwnProperty.call(sandbox, "paths")) throw new TypeError(`Environment ${id} sandbox paths require a sandboxed type`)
		return { type: "none" }
	}
	if (type === "native") {
		for (const field of ["image", "container", "engine"]) {
			if (Object.prototype.hasOwnProperty.call(sandbox, field)) throw new TypeError(`Environment ${id} sandbox ${field} is only valid with sandbox type "container"`)
		}
		return { type: "native", paths: normalizeSandboxPaths(id, sandbox) }
	}
	if (type !== "container") throw new TypeError(`Environment ${id} sandbox type must be "container", "native", or "none"`)
	const image = optionalString(sandbox.image, `Environment ${id} sandbox image`)
	const container = optionalString(sandbox.container, `Environment ${id} sandbox container`)
	const engine = optionalString(sandbox.engine, `Environment ${id} sandbox engine`)
	if (image && container) throw new TypeError(`Environment ${id} sandbox cannot specify both image and container`)
	return {
		type: "container",
		...(image ? { image } : {}),
		...(container ? { container } : {}),
		...(engine ? { engine } : {}),
		paths: normalizeSandboxPaths(id, sandbox),
	}
}

/** @param {string} id @param {any} value */
function normalizeCwd(id, value) {
	const cwd = Object.prototype.hasOwnProperty.call(value, "cwd") && value.cwd !== null
		? String(value.cwd).trim()
		: undefined
	if (cwd !== undefined && (!cwd || !isAbsolute(cwd))) throw new TypeError(`Environment ${id} cwd must be an absolute path`)
	return cwd
}

/** @param {string} id @param {ReturnType<typeof normalizeTarget>} target @param {any} sandbox @param {{ legacy?: boolean }} options */
function environmentRequiresConfiguredCwd(id, target, sandbox, options) {
	if (options.legacy) return false
	if (target.type !== "local") return true
	return false
}

/** @param {ReturnType<typeof normalizeTarget>} target */
function formatTarget(target) {
	if (target.type === "local") return "local"
	if (target.type === "ssh") return `ssh:${target.host}`
	return target.type
}

/** @param {string} id @param {any} value @param {{ legacy?: boolean }} options */
function normalizeLegacyWorkerEnvironment(id, value, options) {
	const worker = typeof value.worker === "string" && value.worker.trim()
		? value.worker.trim()
		: id === "local"
			? "container"
			: undefined
	if (!worker) throw new TypeError(`Environment ${id} requires a worker`)
	const parsed = parseWorkerSpec(worker)
	const image = optionalString(value.image, `Environment ${id} image`)
	if (image !== undefined && parsed.type !== "container") throw new TypeError(`Environment ${id} image is only valid with worker "container"`)
	const cwd = normalizeCwd(id, value)
	const environment = (() => {
		if (parsed.type === "container") return { id, target: { type: "local" }, sandbox: { type: "container", ...(image ? { image } : {}), paths: DEFAULT_SANDBOX_PATHS } }
		if (parsed.type === "local") return { id, target: { type: "local" }, sandbox: { type: "none" } }
		if (parsed.type === "docker") return { id, target: { type: "local" }, sandbox: { type: "container", engine: "docker", container: parsed.container, paths: DEFAULT_SANDBOX_PATHS } }
		if (parsed.type === "ssh") return { id, target: { type: "ssh", host: parsed.target }, sandbox: { type: "none" } }
		throw new TypeError(`Unsupported worker type for environment ${id}: ${parsed.type}`)
	})()
	if (!options.legacy && (parsed.type === "docker" || parsed.type === "ssh") && !cwd) {
		throw new TypeError(`Environment ${id} with ${parsed.type} worker requires cwd`)
	}
	if (environmentRequiresConfiguredCwd(id, environment.target, environment.sandbox, options) && !cwd) {
		throw new TypeError(`Environment ${id} with target ${formatTarget(environment.target)} requires cwd`)
	}
	return { ...environment, ...(cwd ? { cwd } : {}) }
}

/** @param {string} id @param {any} value @param {{ legacy?: boolean }} [options] */
function normalizeEnvironment(id, value, options = {}) {
	validateEnvironmentId(id)
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Environment ${id} must be an object`)
	if (Object.prototype.hasOwnProperty.call(value, "worker")) {
		if (Object.prototype.hasOwnProperty.call(value, "target") || Object.prototype.hasOwnProperty.call(value, "sandbox")) {
			throw new TypeError(`Environment ${id} cannot combine legacy worker with target or sandbox`)
		}
		return normalizeLegacyWorkerEnvironment(id, value, options)
	}
	const target = normalizeTarget(id, value)
	const sandbox = normalizeSandbox(id, value, target)
	const cwd = normalizeCwd(id, value)
	if (environmentRequiresConfiguredCwd(id, target, sandbox, options) && !cwd) {
		throw new TypeError(`Environment ${id} with target ${formatTarget(target)} requires cwd`)
	}
	return { id, target, sandbox, ...(cwd ? { cwd } : {}) }
}

/** @param {any} config @param {{ legacy?: boolean }} [options] */
function normalizeRegistry(config, options = {}) {
	const rawEnvironments = config.environments
	if (rawEnvironments !== undefined && (!rawEnvironments || typeof rawEnvironments !== "object" || Array.isArray(rawEnvironments))) {
		throw new TypeError("environments must be an object mapping ids to environment configs")
	}
	const environments = {}
	for (const [id, value] of Object.entries(rawEnvironments ?? {})) {
		validateEnvironmentId(id)
		if (value !== null) environments[id] = normalizeEnvironment(id, value, options)
	}
	if (!Object.prototype.hasOwnProperty.call(rawEnvironments ?? {}, "local")) environments.local = normalizeEnvironment("local", {}, options)
	const defaultId = typeof config.default === "string" && config.default.trim() ? validateEnvironmentId(config.default.trim()) : "local"
	if (!environments[defaultId]) throw new TypeError(`Default environment is not defined: ${defaultId}`)
	return { default: defaultId, environments }
}

function legacyRegistry() {
	const worker = configuredWorkerSpec()
	return worker
		? normalizeRegistry({ default: "local", environments: { local: { worker } } }, { legacy: true })
		: normalizeRegistry({ default: "local", environments: {} })
}

export function loadEnvironmentRegistry() {
	const config = readEnvironmentsConfig()
	return config ? normalizeRegistry(config) : legacyRegistry()
}

/**
 * Persist an explicit unsandboxed opt-out for one configured environment.
 * Existing target/cwd/default entries are preserved; only the selected
 * environment's sandbox policy is replaced.
 * @param {string} environmentId
 */
export async function disableEnvironmentSandbox(environmentId) {
	validateEnvironmentId(environmentId)
	const config = await readEnvironmentsConfigForWrite()
	const rawEnvironments = config.environments
	if (rawEnvironments !== undefined && (!rawEnvironments || typeof rawEnvironments !== "object" || Array.isArray(rawEnvironments))) {
		throw new TypeError("environments must be an object mapping ids to environment configs")
	}
	const current = rawEnvironments?.[environmentId]
	if (current === null) throw new TypeError(`Environment ${environmentId} is explicitly disabled`)
	if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) {
		throw new TypeError(`Environment ${environmentId} must be an object`)
	}
	const { worker: _worker, image: _image, ...rest } = current ?? {}
	const nextEnvironment = {
		...rest,
		target: rest.target ?? "local",
		sandbox: { type: "none" },
	}
	const path = environmentsConfigPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify({
		...config,
		environments: {
			...(rawEnvironments ?? {}),
			[environmentId]: nextEnvironment,
		},
	}, null, "\t")}\n`, { mode: 0o600 })
}

/** @param {ReturnType<typeof loadEnvironmentRegistry>} [registry] @param {string} [platform] */
export function defaultNativeSandboxEnvironment(registry = loadEnvironmentRegistry(), platform = process.platform) {
	if (platform !== "darwin" && platform !== "linux") return undefined
	const environment = getEnvironment(registry.default, registry)
	if (environment.target?.type !== "local" || environment.sandbox?.type !== "native") return undefined
	return {
		environmentId: environment.id,
		platform,
		sandbox: environment.sandbox,
	}
}

/** @param {ReturnType<typeof loadEnvironmentRegistry>} registry */
function availableEnvironmentIds(registry) {
	return Object.keys(registry.environments ?? {}).sort()
}

/** @param {string} id @param {ReturnType<typeof loadEnvironmentRegistry>} registry */
function unknownEnvironmentError(id, registry) {
	const available = availableEnvironmentIds(registry)
	const suffix = available.length > 0
		? ` Available environments: ${available.join(", ")}.`
		: " No environments are configured."
	return new Error(`Unknown environment id: ${id}.${suffix}`)
}

/** @param {string} id @param {ReturnType<typeof loadEnvironmentRegistry>} [registry] */
export function getEnvironment(id, registry = loadEnvironmentRegistry()) {
	validateEnvironmentId(id)
	const environment = registry.environments[id]
	if (!environment) throw unknownEnvironmentError(id, registry)
	return environment
}

function normalizeResolvedEnvironment(id, environment) {
	return environment?.target && environment?.sandbox ? environment : normalizeEnvironment(id, environment)
}

/**
 * Choose the environment and initial cwd for a new session. Local sessions keep
 * the caller cwd by default; configured non-local environments start at their
 * own cwd so host paths are not implicitly translated into container/remote paths.
 * @param {string} callerCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function initialSessionEnvironment(callerCwd, registry = loadEnvironmentRegistry()) {
	const environment = normalizeResolvedEnvironment(registry.default, getEnvironment(registry.default, registry))
	return {
		environmentId: environment.id,
		cwd: environment.id === "local" && !environment.cwd ? callerCwd : environment.cwd ?? callerCwd,
	}
}

/**
 * Complete a sessionWrite patch whose environment changes but whose cwd is
 * omitted. A configured environment cwd is authoritative for that switch.
 * Re-stating the current environment does not reset a narrowed cwd.
 * @param {any} patch
 * @param {any} current
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function completeEnvironmentPatch(patch, current, registry = loadEnvironmentRegistry()) {
	if (!patch?.environmentId || Object.prototype.hasOwnProperty.call(patch, "cwd")) return patch
	if (patch.environmentId === current?.environmentId) return patch
	const environment = normalizeResolvedEnvironment(patch.environmentId, getEnvironment(patch.environmentId, registry))
	return environment.cwd ? { ...patch, cwd: environment.cwd } : patch
}

/**
 * Resolve the environment/cwd used by the next tool call.
 * @param {any} props
 * @param {string} fallbackCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function resolveExecutionEnvironment(props, fallbackCwd, registry = loadEnvironmentRegistry()) {
	const environmentId = props?.environmentId ?? registry.default
	const environment = normalizeResolvedEnvironment(environmentId, getEnvironment(environmentId, registry))
	return {
		environmentId: environment.id,
		target: environment.target,
		sandbox: environment.sandbox,
		cwd: props?.cwd ?? environment.cwd ?? fallbackCwd,
	}
}

/**
 * Resolve the cwd used as the base for relative sandbox paths. Configured
 * environment cwd values are stable roots; unconfigured environments keep using
 * the caller/session initial cwd as their sandbox root.
 * @param {any} props
 * @param {string} fallbackCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function resolveSandboxRootCwd(props, fallbackCwd, registry = loadEnvironmentRegistry()) {
	const environmentId = props?.environmentId ?? registry.default
	const environment = normalizeResolvedEnvironment(environmentId, getEnvironment(environmentId, registry))
	return environment.cwd ?? fallbackCwd
}
