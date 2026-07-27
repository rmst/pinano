import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

import { environmentsConfigPath } from "../paths.js"

const ENVIRONMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const DEFAULT_MOUNT_PATHS = []

function defaultLocalSandbox() {
	return process.platform === "darwin" || process.platform === "linux"
		? { type: "native" }
		: { type: "container" }
}

/** @param {string} path */
function readEnvironmentsConfigFile(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("environments.json must contain an object")
		return parsed
	} catch (err) {
		if (err?.code === "ENOENT") return undefined
		throw err
	}
}

function readEnvironmentsConfig() {
	return readEnvironmentsConfigFile(environmentsConfigPath())
}

/** @param {string} path */
async function readEnvironmentsConfigFileForWrite(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("environments.json must contain an object")
		return parsed
	} catch (err) {
		if (err?.code === "ENOENT") return {}
		throw err
	}
}

async function readEnvironmentsConfigForWrite() {
	return readEnvironmentsConfigFileForWrite(environmentsConfigPath())
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

/** @param {any} value @param {string} field */
function optionalBoolean(value, field) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`)
	return value
}

function assertOnlyFields(value, fields, context) {
	for (const field of Object.keys(value)) {
		if (!fields.includes(field)) throw new TypeError(`${context} field ${field} is not supported`)
	}
}

function normalizeEnv(id, value) {
	if (value === undefined || value === null) return undefined
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Environment ${id} sandbox env must be an object`)
	return Object.fromEntries(Object.entries(value).map(([name, envValue]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Environment ${id} sandbox env name is invalid: ${name}`)
		if (typeof envValue !== "string") throw new TypeError(`Environment ${id} sandbox env ${name} must be a string`)
		return [name, envValue]
	}))
}

function normalizeExtraArgs(id, value) {
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value)) throw new TypeError(`Environment ${id} sandbox extraArgs must be an array`)
	return value.map((item, index) => {
		if (typeof item !== "string") throw new TypeError(`Environment ${id} sandbox extraArgs[${index}] must be a string`)
		const arg = item.trim()
		if (!arg) throw new TypeError(`Environment ${id} sandbox extraArgs[${index}] must be a non-empty string`)
		return arg
	})
}

function normalizeMountPath(id, item, index, type) {
	if (typeof item === "string") {
		const path = item.trim()
		if (!path) throw new TypeError(`Environment ${id} sandbox mountPaths[${index}] must be a non-empty string`)
		return path
	}
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		throw new TypeError(`Environment ${id} sandbox mountPaths[${index}] must be a string or object`)
	}
	assertOnlyFields(item, ["from", "to", "readOnly"], `Environment ${id} sandbox mountPaths[${index}]`)
	const from = optionalString(item.from, `Environment ${id} sandbox mountPaths[${index}].from`)
	if (!from) throw new TypeError(`Environment ${id} sandbox mountPaths[${index}].from is required`)
	const to = optionalString(item.to, `Environment ${id} sandbox mountPaths[${index}].to`)
	if (to && type !== "container") {
		if (from !== to) throw new TypeError(`Environment ${id} sandbox mountPaths[${index}].to is only valid with sandbox type "container" unless it matches from`)
		if (!isAbsolute(from)) throw new TypeError(`Environment ${id} sandbox mountPaths[${index}].to on a native sandbox requires an absolute from path`)
	}
	if (to && !isAbsolute(to)) throw new TypeError(`Environment ${id} sandbox mountPaths[${index}].to must be an absolute path`)
	const readOnly = optionalBoolean(item.readOnly, `Environment ${id} sandbox mountPaths[${index}].readOnly`)
	return {
		from,
		...(to && type === "container" ? { to } : {}),
		...(readOnly === true ? { readOnly: true } : {}),
	}
}

/** @param {string} id @param {any} value @param {string} type */
function normalizeMountPaths(id, value, type) {
	const raw = Object.prototype.hasOwnProperty.call(value, "mountPaths") ? value.mountPaths : DEFAULT_MOUNT_PATHS
	if (!Array.isArray(raw)) throw new TypeError(`Environment ${id} sandbox mountPaths must be an array`)
	return raw.map((item, index) => normalizeMountPath(id, item, index, type))
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
	const isolatedHome = Object.prototype.hasOwnProperty.call(sandbox, "isolatedHome")
		? optionalBoolean(sandbox.isolatedHome, `Environment ${id} sandbox isolatedHome`)
		: undefined
	if (type === "none") {
		assertOnlyFields(sandbox, ["type"], `Environment ${id} sandbox`)
		return { type: "none" }
	}
	const mountPaths = normalizeMountPaths(id, sandbox, type)
	const useSessionWd = optionalBoolean(sandbox.useSessionWd, `Environment ${id} sandbox useSessionWd`) ?? true
	if (type === "native") {
		assertOnlyFields(sandbox, ["type", "useSessionWd", "isolatedHome", "mountPaths"], `Environment ${id} sandbox`)
		return {
			type: "native",
			useSessionWd,
			mountPaths,
			...(isolatedHome === false ? { isolatedHome: false } : {}),
		}
	}
	if (type !== "container") throw new TypeError(`Environment ${id} sandbox type must be "container", "native", or "none"`)
	assertOnlyFields(sandbox, ["type", "image", "container", "engine", "user", "useSessionWd", "isolatedHome", "mountPaths", "env", "network", "extraArgs"], `Environment ${id} sandbox`)
	const image = optionalString(sandbox.image, `Environment ${id} sandbox image`)
	const container = optionalString(sandbox.container, `Environment ${id} sandbox container`)
	const engine = optionalString(sandbox.engine, `Environment ${id} sandbox engine`)
	const user = optionalString(sandbox.user, `Environment ${id} sandbox user`)
	const env = normalizeEnv(id, sandbox.env)
	const network = optionalString(sandbox.network, `Environment ${id} sandbox network`)
	const extraArgs = normalizeExtraArgs(id, sandbox.extraArgs)
	if (image && container) throw new TypeError(`Environment ${id} sandbox cannot specify both image and container`)
	if (container && isolatedHome !== undefined) throw new TypeError(`Environment ${id} sandbox isolatedHome is only valid for native or Cerex-managed container sandboxes`)
	if (container && user) throw new TypeError(`Environment ${id} sandbox user is only valid for Cerex-managed containers`)
	if (container && network) throw new TypeError(`Environment ${id} sandbox network is only valid for Cerex-managed containers`)
	if (container && extraArgs?.length) throw new TypeError(`Environment ${id} sandbox extraArgs are only valid for Cerex-managed containers`)
	return {
		type: "container",
		...(image ? { image } : {}),
		...(container ? { container } : {}),
		...(engine ? { engine } : {}),
		...(user ? { user } : {}),
		useSessionWd,
		mountPaths,
		...(isolatedHome === false ? { isolatedHome: false } : {}),
		...(env ? { env } : {}),
		...(network ? { network } : {}),
		...(extraArgs?.length ? { extraArgs } : {}),
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

/** @param {ReturnType<typeof normalizeTarget>} target */
function environmentRequiresConfiguredCwd(target) {
	return target.type !== "local"
}

/** @param {ReturnType<typeof normalizeTarget>} target */
function formatTarget(target) {
	if (target.type === "local") return "local"
	if (target.type === "ssh") return `ssh:${target.host}`
	return target.type
}

/** @param {string} id @param {any} value */
function normalizeEnvironment(id, value) {
	validateEnvironmentId(id)
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Environment ${id} must be an object`)
	assertOnlyFields(value, ["target", "sandbox", "cwd"], `Environment ${id}`)
	const target = normalizeTarget(id, value)
	const sandbox = normalizeSandbox(id, value, target)
	const cwd = normalizeCwd(id, value)
	if (environmentRequiresConfiguredCwd(target) && !cwd) {
		throw new TypeError(`Environment ${id} with target ${formatTarget(target)} requires cwd`)
	}
	return { id, target, sandbox, ...(cwd ? { cwd } : {}) }
}

/** @param {any} config */
function normalizeRegistry(config) {
	assertOnlyFields(config, ["default", "environments"], "Environment registry")
	const rawEnvironments = config.environments
	if (rawEnvironments !== undefined && (!rawEnvironments || typeof rawEnvironments !== "object" || Array.isArray(rawEnvironments))) {
		throw new TypeError("environments must be an object mapping ids to environment configs")
	}
	const environments = {}
	for (const [id, value] of Object.entries(rawEnvironments ?? {})) {
		validateEnvironmentId(id)
		if (value !== null) environments[id] = normalizeEnvironment(id, value)
	}
	if (!Object.prototype.hasOwnProperty.call(rawEnvironments ?? {}, "local")) environments.local = normalizeEnvironment("local", {})
	const defaultId = typeof config.default === "string" && config.default.trim() ? validateEnvironmentId(config.default.trim()) : "local"
	if (!environments[defaultId]) throw new TypeError(`Default environment is not defined: ${defaultId}`)
	return { default: defaultId, environments }
}

export function loadEnvironmentRegistry() {
	return normalizeRegistry(readEnvironmentsConfig() ?? {})
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
	if (current) assertOnlyFields(current, ["target", "sandbox", "cwd"], `Environment ${environmentId}`)
	const rest = current ?? {}
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

/** Resolve persisted session environment ids against the current registry. Explicit writes still validate through getEnvironment. */
export function resolveConfiguredEnvironmentId(id, registry = loadEnvironmentRegistry()) {
	const requested = id ?? registry.default
	validateEnvironmentId(requested)
	return registry.environments[requested] ? requested : registry.default
}

function normalizeResolvedEnvironment(id, environment) {
	return environment?.target && environment?.sandbox ? environment : normalizeEnvironment(id, environment)
}

/**
 * Choose the environment and initial cwd for a new session. Local sessions keep
 * the caller cwd; SSH environments start at their configured remote cwd because
 * local caller paths cannot be translated safely.
 * @param {string} callerCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function initialSessionEnvironment(callerCwd, registry = loadEnvironmentRegistry()) {
	const environment = normalizeResolvedEnvironment(registry.default, getEnvironment(registry.default, registry))
	return {
		environmentId: environment.id,
		cwd: environment.target?.type === "ssh" ? environment.cwd ?? callerCwd : callerCwd,
	}
}

/**
 * Complete a session property patch whose environment changes but whose cwd is
 * omitted. SSH targets inherit their configured cwd; local targets preserve the
 * current session cwd. Re-stating the current environment does not reset a
 * narrowed cwd.
 * @param {any} patch
 * @param {any} current
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function completeEnvironmentPatch(patch, current, registry = loadEnvironmentRegistry()) {
	if (!patch?.environmentId || Object.prototype.hasOwnProperty.call(patch, "cwd")) return patch
	if (patch.environmentId === current?.environmentId) return patch
	const environment = normalizeResolvedEnvironment(patch.environmentId, getEnvironment(patch.environmentId, registry))
	return environment.target?.type === "ssh" && environment.cwd ? { ...patch, cwd: environment.cwd } : patch
}

/**
 * Resolve the environment/cwd used by the next tool call.
 * @param {any} props
 * @param {string} fallbackCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function resolveExecutionEnvironment(props, fallbackCwd, registry = loadEnvironmentRegistry()) {
	const environmentId = resolveConfiguredEnvironmentId(props?.environmentId, registry)
	const environment = normalizeResolvedEnvironment(environmentId, getEnvironment(environmentId, registry))
	return {
		environmentId: environment.id,
		target: environment.target,
		sandbox: environment.sandbox,
		cwd: props?.cwd ?? (environment.target?.type === "ssh" ? environment.cwd : undefined) ?? fallbackCwd,
	}
}

/**
 * Resolve the startup directory used by sandboxed workers and as the base for
 * relative mountPaths.
 * @param {any} props
 * @param {string} fallbackCwd
 * @param {ReturnType<typeof loadEnvironmentRegistry>} [registry]
 */
export function resolveSessionWd(props, fallbackCwd, registry = loadEnvironmentRegistry()) {
	const environmentId = resolveConfiguredEnvironmentId(props?.environmentId, registry)
	const environment = normalizeResolvedEnvironment(environmentId, getEnvironment(environmentId, registry))
	return environment.target?.type === "ssh" ? environment.cwd ?? fallbackCwd : fallbackCwd
}

export const resolveSandboxRootCwd = resolveSessionWd
