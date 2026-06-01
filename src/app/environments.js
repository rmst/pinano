import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"

import { environmentsConfigPath } from "./paths.js"
import { configuredWorkerSpec } from "./service-config.js"
import { parseWorkerSpec } from "./worker-launchers.js"

const ENVIRONMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

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

/** @param {string} id */
function validateEnvironmentId(id) {
	if (typeof id !== "string" || !ENVIRONMENT_ID_RE.test(id)) {
		throw new TypeError(`Invalid environment id: ${id}. Use 1-64 letters, numbers, _ or -, starting with a letter or number.`)
	}
	return id
}

/** @param {string} id @param {any} value @param {{ legacy?: boolean }} [options] */
function normalizeEnvironment(id, value, options = {}) {
	validateEnvironmentId(id)
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Environment ${id} must be an object`)
	const worker = typeof value.worker === "string" && value.worker.trim()
		? value.worker.trim()
		: id === "local"
			? "local"
			: undefined
	if (!worker) throw new TypeError(`Environment ${id} requires a worker`)
	const parsedWorker = parseWorkerSpec(worker)
	const cwd = Object.prototype.hasOwnProperty.call(value, "cwd") && value.cwd !== null
		? String(value.cwd).trim()
		: undefined
	if (cwd !== undefined && (!cwd || !isAbsolute(cwd))) throw new TypeError(`Environment ${id} cwd must be an absolute path`)
	if (!options.legacy && parsedWorker.type !== "local" && !cwd) throw new TypeError(`Environment ${id} with ${parsedWorker.type} worker requires cwd`)
	return { id, worker, ...(cwd ? { cwd } : {}) }
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
	if (!Object.prototype.hasOwnProperty.call(rawEnvironments ?? {}, "local")) environments.local = normalizeEnvironment("local", { worker: "local" }, options)
	const defaultId = typeof config.default === "string" && config.default.trim() ? validateEnvironmentId(config.default.trim()) : "local"
	if (!environments[defaultId]) throw new TypeError(`Default environment is not defined: ${defaultId}`)
	return { default: defaultId, environments }
}

function legacyRegistry() {
	const worker = configuredWorkerSpec() ?? "local"
	return normalizeRegistry({ default: "local", environments: { local: { worker } } }, { legacy: true })
}

export function loadEnvironmentRegistry() {
	const config = readEnvironmentsConfig()
	return config ? normalizeRegistry(config) : legacyRegistry()
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

/**
 * Choose the environment and initial cwd for a new session. Local sessions keep
 * the caller cwd by default; configured non-local environments start at their
 * own cwd so host paths are not implicitly translated into container/remote paths.
 * @param {string} callerCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function initialSessionEnvironment(callerCwd, registry = loadEnvironmentRegistry()) {
	const environment = getEnvironment(registry.default, registry)
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
	const environment = getEnvironment(patch.environmentId, registry)
	return environment.cwd ? { ...patch, cwd: environment.cwd } : patch
}

/**
 * Resolve the environment/cwd used by the next tool call.
 * @param {any} props
 * @param {string} fallbackCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function resolveExecutionEnvironment(props, fallbackCwd, registry = loadEnvironmentRegistry()) {
	const environment = getEnvironment(props?.environmentId ?? registry.default, registry)
	return {
		environmentId: environment.id,
		worker: environment.worker,
		cwd: props?.cwd ?? environment.cwd ?? fallbackCwd,
	}
}
