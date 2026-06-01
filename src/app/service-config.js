import { readFileSync } from "node:fs"

import { serviceConfigPath } from "./paths.js"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

function readConfig() {
	try {
		const parsed = JSON.parse(readFileSync(serviceConfigPath(), "utf-8"))
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch (err) {
		if (err?.code === "ENOENT") return {}
		throw err
	}
}

export function loadServiceConfig() {
	return readConfig()
}

export function configuredWorkerSpec() {
	const config = readConfig()
	return typeof config.worker === "string" && config.worker.trim() ? config.worker.trim() : undefined
}

export function configuredProviderApiKey(provider) {
	const config = readConfig()
	const providers = config.providers && typeof config.providers === "object" ? config.providers : {}
	const entry = providers[provider]
	if (typeof entry === "string") return entry
	if (entry && typeof entry === "object" && typeof entry.apiKey === "string") return entry.apiKey
	return undefined
}

export function isModelIoLogConfigured() {
	const config = readConfig()
	if (typeof config.modelIoLog === "boolean") return config.modelIoLog
	if (typeof config.modelIoLog === "string") return TRUE_VALUES.has(config.modelIoLog.toLowerCase())
	return false
}

export function configuredModelIoLogDbPath() {
	const config = readConfig()
	return typeof config.modelIoLogDb === "string" && config.modelIoLogDb ? config.modelIoLogDb : undefined
}

function webConfigValue(config = readConfig()) {
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
	if (value.dev === true) defaults.dev = true
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
	const config = readConfig()
	if (typeof config.token === "string" && config.token) return config.token
	const web = webConfigValue(config)
	return typeof web.token === "string" && web.token ? web.token : undefined
}

export function configuredServiceDiagnostics() {
	const config = readConfig()
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
