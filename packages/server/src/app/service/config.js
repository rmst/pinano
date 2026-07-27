import { loadSettingsSync } from "../settings.js"
import { normalizeWebPasswordAuthConfig } from "../web/config.js"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

function serviceSettings() {
	return loadSettingsSync().service ?? {}
}

export function loadServiceConfig() {
	return serviceSettings()
}

export function configuredProviderApiKey(provider) {
	const providers = loadSettingsSync().providers ?? {}
	const entry = providers[provider]
	if (entry && typeof entry === "object" && typeof entry.apiKey === "string") return entry.apiKey
	return undefined
}

export function isModelIoLogConfigured() {
	const config = serviceSettings()
	if (typeof config.modelIoLog === "boolean") return config.modelIoLog
	if (typeof config.modelIoLog === "string") return TRUE_VALUES.has(config.modelIoLog.toLowerCase())
	return false
}

export function configuredModelIoLogDbPath() {
	const config = serviceSettings()
	return typeof config.modelIoLogDb === "string" && config.modelIoLogDb ? config.modelIoLogDb : undefined
}

function webConfigValue(config = serviceSettings()) {
	const value = config.web
	return value && typeof value === "object" ? value : {}
}

export function configuredWebDefaults() {
	const value = webConfigValue()
	const port = typeof value.port === "number"
		? value.port
		: typeof value.port === "string" && value.port.trim()
			? Number(value.port)
			: undefined
	const defaults = {}
	if (typeof value.host === "string" && value.host) defaults.host = value.host
	if (Number.isInteger(port)) defaults.port = Math.max(0, port)
	if (typeof value.token === "string" && value.token) defaults.token = value.token
	if (typeof value.publicUrl === "string" && value.publicUrl) defaults.publicUrl = value.publicUrl
	if (typeof value.initialRoute === "string" && value.initialRoute) defaults.initialRoute = value.initialRoute
	if (value.dev === true) defaults.dev = true
	if (typeof value.idleKeepAlive === "boolean") defaults.idleKeepAlive = value.idleKeepAlive
	if (value.auth === false) defaults.auth = false
	else {
		const auth = normalizeWebPasswordAuthConfig(value.auth)
		if (auth) defaults.auth = auth
	}
	return defaults
}

export function configuredServiceEndpointDefaults() {
	const defaults = configuredWebDefaults()
	return {
		host: defaults.host || "127.0.0.1",
		port: Number.isInteger(defaults.port) ? defaults.port : 0,
	}
}

export function configuredServiceToken() {
	const config = serviceSettings()
	if (typeof config.token === "string" && config.token) return config.token
	const web = webConfigValue(config)
	return typeof web.token === "string" && web.token ? web.token : undefined
}

export function configuredServiceDiagnostics() {
	const config = serviceSettings()
	const value = config.diagnostics
	if (value === undefined || value === null) return { enabled: false }
	if (typeof value === "boolean") return { enabled: value }
	if (typeof value === "string") return { enabled: TRUE_VALUES.has(value.toLowerCase()) }
	if (typeof value !== "object") return { enabled: false }
	const enabled = value.enabled === undefined ? true : value.enabled
	return {
		enabled: typeof enabled === "boolean" ? enabled : TRUE_VALUES.has(String(enabled).toLowerCase()),
		path: typeof value.path === "string" && value.path ? value.path : undefined,
		slowSpanMs: value.slowSpanMs,
		eventLoopLagMs: value.eventLoopLagMs,
		eventLoopIntervalMs: value.eventLoopIntervalMs,
		probeIntervalMs: value.probeIntervalMs,
		maxBytes: value.maxBytes,
		recordAllSpans: value.recordAllSpans,
	}
}

export function configuredServiceDebug() {
	const config = serviceSettings()
	const value = config.debug
	if (value === undefined || value === null) return { inspect: false, heapSnapshot: false, allowNonLoopback: false }
	if (typeof value === "boolean") return { inspect: value, heapSnapshot: false, allowNonLoopback: false }
	if (typeof value === "string") return { inspect: TRUE_VALUES.has(value.toLowerCase()), heapSnapshot: false, allowNonLoopback: false }
	if (typeof value !== "object") return { inspect: false, heapSnapshot: false, allowNonLoopback: false }
	const enabled = value.enabled === undefined ? undefined : (typeof value.enabled === "boolean" ? value.enabled : TRUE_VALUES.has(String(value.enabled).toLowerCase()))
	const inspect = value.inspect === undefined
		? enabled === true
		: typeof value.inspect === "boolean"
			? value.inspect
			: TRUE_VALUES.has(String(value.inspect).toLowerCase())
	return {
		inspect,
		heapSnapshot: value.heapSnapshot === true || (typeof value.heapSnapshot === "string" && TRUE_VALUES.has(value.heapSnapshot.toLowerCase())),
		allowNonLoopback: value.allowNonLoopback === true || (typeof value.allowNonLoopback === "string" && TRUE_VALUES.has(value.allowNonLoopback.toLowerCase())),
	}
}
