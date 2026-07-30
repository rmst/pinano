// Settings persisted under $CEREX_HOME.
//
// default-settings.json is launcher/deployment-owned and never written here.
// settings.json is the user override layer and is the only file update paths
// mutate. Runtime code reads the merged view: built-ins < defaults < user.

import { readFileSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { normalizeReasoningLevel } from "../../../protocol/src/reasoning.js"
import { defaultSettingsPath, settingsPath } from "./paths.js"
import { showSubscriptionUsageStatusFromSettings } from "./usage/subscription-display.js"
import { normalizeStateMount } from "./workers/tool/state-mounts.js"

/** @typedef {import("../../../protocol/src/reasoning.js").ReasoningLevel} ThinkingLevel */

/**
 * @typedef {object} ProviderModelSettings
 * @property {string} [id]
 * @property {string} [extends]
 * @property {string} [displayName]
 * @property {"openai" | "openai-codex" | "llamacpp" | "moonshot" | "deepseek"} [authProvider]
 * @property {string} [baseUrl]
 * @property {string} [wireModel]
 * @property {boolean} [reasoning]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} [cost]
 * @property {("text" | "image")[]} [input]
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} [compat]
 * @property {{ remoteResponses?: boolean }} [compaction]
 * @property {"chat" | "responses"} [transport]
 * @property {"auto" | "sse" | "websocket"} [codexTransport]
 * @property {string} [maintenanceModelRef]
 * @property {"default" | "codex"} [toolProfile]
 * @property {"code_mode_only"} [toolMode]
 * @property {boolean} [useResponsesLite]
 * @property {string[]} [serviceTiers]
 * @property {string[]} [tags]
 */

/**
 * @typedef {object} ProviderSettings
 * @property {string} [displayName]
 * @property {"openai" | "openai-codex" | "llamacpp" | "moonshot" | "deepseek"} [authProvider]
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} [compat]
 * @property {"chat" | "responses"} [transport]
 * @property {"auto" | "sse" | "websocket"} [codexTransport]
 * @property {ProviderModelSettings[]} [models]
 * @property {Record<string, ProviderModelSettings>} [modelOverrides]
 */

/**
 * @typedef {object} ServiceSettings
 * @property {string} [worker]
 * @property {boolean | string} [modelIoLog]
 * @property {string} [modelIoLogDb]
 * @property {string} [token]
 * @property {string} [workspaceRoot]
 * @property {{ host?: string, port?: number | string, token?: string, publicUrl?: string, initialRoute?: string, previewRoutingSlug?: string, routingSlug?: string, dev?: boolean, idleKeepAlive?: boolean, showProjectRootPath?: boolean, codeMirrorEditor?: boolean, modelCredentials?: boolean, auth?: false | { type?: "password", users?: Record<string, string> } }} [web]
 * @property {boolean | string | Record<string, unknown>} [diagnostics]
 * @property {boolean | string | Record<string, unknown>} [debug]
 */

/**
 * @typedef {object} ToolSandboxSettings
 * @property {import("./workers/tool/state-mounts.js").StateMountMode} stateMount
 */

/**
 * @typedef {object} Settings
 * @property {string} defaultModel
 * @property {Record<string, ProviderSettings>} providers
 * @property {ServiceSettings} service
 * @property {ToolSandboxSettings} toolSandbox
 * @property {ThinkingLevel} thinkingLevel
 * @property {boolean} web
 * @property {boolean} updateCheck
 * @property {boolean} buildFromSource
 * @property {boolean} showThinkingOutput
 * @property {boolean} showToolOutput
 * @property {boolean} showDeletedSessions
 * @property {boolean} showSubscriptionUsageStatus
 */

/** @typedef {Partial<Settings>} RawSettings */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
	defaultModel: "openai-codex/gpt-5.6-sol",
	providers: {},
	service: {},
	toolSandbox: { stateMount: false },
	thinkingLevel: "default",
	web: false,
	updateCheck: true,
	buildFromSource: false,
	showThinkingOutput: false,
	showToolOutput: false,
	showDeletedSessions: false,
	showSubscriptionUsageStatus: true,
}

const SETTING_KEYS = /** @type {const} */ ([
	"defaultModel",
	"providers",
	"service",
	"toolSandbox",
	"thinkingLevel",
	"web",
	"updateCheck",
	"buildFromSource",
	"showThinkingOutput",
	"showToolOutput",
	"showDeletedSessions",
	"showSubscriptionUsageStatus",
])

/**
 * @param {Record<string, unknown>} parsed
 * @returns {RawSettings}
 */
function pickSettingsKeys(parsed) {
	/** @type {RawSettings} */
	const settings = {}
	for (const key of SETTING_KEYS) {
		if (Object.hasOwn(parsed, key)) settings[key] = /** @type {any} */ (parsed[key])
	}
	return settings
}

/**
 * @param {string} path
 * @returns {RawSettings}
 */
function readSettingsFileSync(path) {
	try {
		const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf-8")))
		return pickSettingsKeys(parsed)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return {}
		throw err
	}
}

/**
 * @param {string} path
 * @returns {Promise<RawSettings>}
 */
async function readSettingsFile(path) {
	try {
		const text = await readFile(path, "utf-8")
		const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(text))
		return pickSettingsKeys(parsed)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return {}
		throw err
	}
}

function plainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

/** @param {unknown} value */
function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined
}

/** @param {unknown} value */
function positiveNumberOrUndefined(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** @param {unknown} value */
function finiteNumberOrUndefined(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** @param {unknown} value */
function cleanCost(value) {
	const cost = plainObject(value)
	const out = {}
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		const next = finiteNumberOrUndefined(cost[key])
		if (next !== undefined) out[key] = next
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {unknown} value */
function cleanStringRecord(value) {
	const record = plainObject(value)
	const out = {}
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === "string") out[key] = item
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {unknown} value */
function cleanWebAuthSettings(value) {
	if (value === false) return false
	const raw = plainObject(value)
	if (Object.keys(raw).length === 0) return undefined
	if (raw.type !== undefined && raw.type !== "password") return undefined
	const users = {}
	for (const [username, password] of Object.entries(plainObject(raw.users))) {
		if (username && typeof password === "string" && password) users[username] = password
	}
	if (Object.keys(users).length === 0) return undefined
	return { type: "password", users }
}

/** @param {unknown} value */
function cleanModelSettings(value) {
	const model = plainObject(value)
	if (Object.keys(model).length === 0) return undefined
	const out = {}
	for (const key of ["id", "extends", "displayName", "authProvider", "baseUrl", "wireModel", "maintenanceModelRef", "toolProfile", "transport"]) {
		if (typeof model[key] === "string" && model[key]) out[key] = model[key]
	}
	if (model.codexTransport === "auto" || model.codexTransport === "sse" || model.codexTransport === "websocket") {
		out.codexTransport = model.codexTransport
	}
	if (model.toolMode === "code_mode_only") out.toolMode = model.toolMode
	if (typeof model.reasoning === "boolean") out.reasoning = model.reasoning
	if (typeof model.useResponsesLite === "boolean") out.useResponsesLite = model.useResponsesLite
	const contextWindow = positiveNumberOrUndefined(model.contextWindow)
	if (contextWindow !== undefined) out.contextWindow = contextWindow
	const maxTokens = positiveNumberOrUndefined(model.maxTokens)
	if (maxTokens !== undefined) out.maxTokens = maxTokens
	const cost = cleanCost(model.cost)
	if (cost) out.cost = cost
	const input = stringArray(model.input)?.filter((item) => item === "text" || item === "image")
	if (input?.length) out.input = input
	const headers = cleanStringRecord(model.headers)
	if (headers) out.headers = headers
	const compat = plainObject(model.compat)
	if (Object.keys(compat).length > 0) out.compat = compat
	const compaction = plainObject(model.compaction)
	if (typeof compaction.remoteResponses === "boolean") out.compaction = { remoteResponses: compaction.remoteResponses }
	const tags = stringArray(model.tags)
	if (tags) out.tags = tags
	const serviceTiers = stringArray(model.serviceTiers)
	if (serviceTiers) out.serviceTiers = serviceTiers
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {unknown} value */
function cleanModelsArray(value) {
	if (!Array.isArray(value)) return undefined
	return value
		.map(cleanModelSettings)
		.filter((model) => model && typeof model.id === "string" && model.id)
}

/** @param  {...(ProviderModelSettings[] | undefined)} sources */
function mergeModelArrays(...sources) {
	const byId = new Map()
	for (const source of sources) {
		for (const model of source ?? []) {
			if (!model?.id) continue
			byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model })
		}
	}
	return [...byId.values()]
}

/** @param {unknown} value */
function cleanModelOverrides(value) {
	const overrides = plainObject(value)
	const out = {}
	for (const [id, override] of Object.entries(overrides)) {
		const clean = cleanModelSettings({ id, ...plainObject(override) })
		if (clean) {
			delete clean.id
			out[id] = clean
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {ProviderSettings | undefined} base @param {unknown} value */
function mergeProviderSettings(base, value) {
	const raw = plainObject(value)
	if (Object.keys(raw).length === 0) return base
	const next = { ...(base ?? {}) }
	for (const key of ["displayName", "authProvider", "baseUrl", "apiKey", "transport"]) {
		if (typeof raw[key] === "string" && raw[key]) next[key] = raw[key]
	}
	if (raw.codexTransport === "auto" || raw.codexTransport === "sse" || raw.codexTransport === "websocket") {
		next.codexTransport = raw.codexTransport
	}
	const headers = cleanStringRecord(raw.headers)
	if (headers) next.headers = { ...(next.headers ?? {}), ...headers }
	const compat = plainObject(raw.compat)
	if (Object.keys(compat).length > 0) next.compat = { ...(next.compat ?? {}), ...compat }
	const models = cleanModelsArray(raw.models)
	if (models) next.models = mergeModelArrays(next.models, models)
	const overrides = cleanModelOverrides(raw.modelOverrides)
	if (overrides) {
		next.modelOverrides = { ...(next.modelOverrides ?? {}) }
		for (const [id, override] of Object.entries(overrides)) {
			next.modelOverrides[id] = { ...(next.modelOverrides[id] ?? {}), ...override }
		}
	}
	return next
}

function mergeProviders(...sources) {
	const merged = {}
	for (const source of sources) {
		for (const [id, config] of Object.entries(plainObject(source))) {
			const next = mergeProviderSettings(merged[id], config)
			if (next) merged[id] = next
		}
	}
	return merged
}

/** @param {unknown} value */
function cleanServiceSettings(value) {
	const raw = plainObject(value)
	const out = {}
	for (const key of ["worker", "modelIoLogDb", "token", "workspaceRoot"]) {
		if (typeof raw[key] === "string" && raw[key]) out[key] = raw[key]
	}
	if (typeof raw.modelIoLog === "boolean" || typeof raw.modelIoLog === "string") out.modelIoLog = raw.modelIoLog
	const web = plainObject(raw.web)
	if (Object.keys(web).length > 0) {
		out.web = {}
		for (const key of ["host", "token", "publicUrl", "initialRoute", "previewRoutingSlug", "routingSlug"]) {
			if (typeof web[key] === "string" && web[key]) out.web[key] = web[key]
		}
		if (typeof web.port === "number" || typeof web.port === "string") out.web.port = web.port
		if (web.dev === true) out.web.dev = true
		if (typeof web.idleKeepAlive === "boolean") out.web.idleKeepAlive = web.idleKeepAlive
		if (typeof web.showProjectRootPath === "boolean") out.web.showProjectRootPath = web.showProjectRootPath
		if (typeof web.codeMirrorEditor === "boolean") out.web.codeMirrorEditor = web.codeMirrorEditor
		if (typeof web.modelCredentials === "boolean") out.web.modelCredentials = web.modelCredentials
		const auth = cleanWebAuthSettings(web.auth)
		if (auth !== undefined) out.web.auth = auth
	}
	for (const key of ["diagnostics", "debug"]) {
		if (typeof raw[key] === "boolean" || typeof raw[key] === "string") out[key] = raw[key]
		else {
			const value = plainObject(raw[key])
			if (Object.keys(value).length > 0) out[key] = value
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {(ServiceSettings | undefined)[]} sources */
function mergeServiceSettings(...sources) {
	const merged = {}
	for (const source of sources) {
		const service = cleanServiceSettings(source)
		if (!service) continue
		const web = service.web
		const previousWeb = plainObject(merged.web)
		Object.assign(merged, service)
		if (web) {
			const auth = web.auth
			const previousAuth = plainObject(previousWeb.auth)
			merged.web = { ...previousWeb, ...web }
			if (auth === false) {
				merged.web.auth = false
			} else if (auth) {
				merged.web.auth = {
					...previousAuth,
					...auth,
					users: {
						...plainObject(previousAuth.users),
						...plainObject(auth.users),
					},
				}
			}
		}
		for (const key of ["diagnostics", "debug"]) {
			const value = service[key]
			if (value && typeof value === "object" && !Array.isArray(value)) {
				merged[key] = { ...(typeof merged[key] === "object" && !Array.isArray(merged[key]) ? merged[key] : {}), ...value }
			}
		}
	}
	return merged
}

/** @param {unknown} value */
function cleanToolSandboxSettings(value) {
	const raw = plainObject(value)
	const out = {}
	const configured = Object.hasOwn(raw, "stateMount") ? raw.stateMount : raw.pinanoStateMount
	if (configured !== undefined) {
		const mode = normalizeStateMount(configured)
		if (mode !== undefined) out.stateMount = mode
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** @param {(ToolSandboxSettings | undefined)[]} sources */
function mergeToolSandboxSettings(...sources) {
	const merged = {}
	for (const source of sources) {
		const settings = cleanToolSandboxSettings(source)
		if (settings) Object.assign(merged, settings)
	}
	return { stateMount: false, ...merged }
}

/** @param {string} ref */
function splitDefaultModelRef(ref) {
	const match = ref.match(/^([^/]+)\/(.+)$/)
	return match ? { provider: match[1], id: match[2] } : { id: ref }
}

/** @param {string} ref */
function defaultModelProvider(ref) {
	return splitDefaultModelRef(ref).provider
}

/**
 * @param {unknown} ref
 * @param {string | undefined} provider
 */
function normalizeDefaultModelRef(ref, provider) {
	if (typeof ref !== "string") return undefined
	const value = ref.trim()
	if (!value) return undefined
	const parsed = splitDefaultModelRef(value)
	if (parsed.provider) return `${parsed.provider}/${parsed.id}`
	const fallbackProvider = provider || defaultModelProvider(DEFAULT_SETTINGS.defaultModel)
	return fallbackProvider ? `${fallbackProvider}/${parsed.id}` : parsed.id
}

/** @param {(RawSettings | undefined)[]} sources */
function mergeDefaultModel(...sources) {
	let current = DEFAULT_SETTINGS.defaultModel
	for (const source of sources) {
		const model = typeof source?.defaultModel === "string" && source.defaultModel.trim() ? source.defaultModel.trim() : undefined
		if (model) current = normalizeDefaultModelRef(model, defaultModelProvider(current)) ?? current
	}
	return current
}

/**
 * @param {RawSettings} settings
 * @param {Pick<Settings, "defaultModel">} current
 * @returns {Partial<Settings>}
 */
function settingsForWrite(settings, current) {
	const out = { ...settings }
	const model = typeof out.defaultModel === "string" && out.defaultModel.trim() ? out.defaultModel.trim() : undefined
	if (model) out.defaultModel = normalizeDefaultModelRef(model, defaultModelProvider(current.defaultModel))
	else delete out.defaultModel
	return out
}

/**
 * @param {RawSettings} defaultSettings
 * @param {RawSettings} userSettings
 * @returns {Settings}
 */
function mergeSettings(defaultSettings, userSettings) {
	const merged = { ...DEFAULT_SETTINGS, ...defaultSettings, ...userSettings }
	merged.providers = mergeProviders(DEFAULT_SETTINGS.providers, defaultSettings.providers, userSettings.providers)
	merged.service = mergeServiceSettings(DEFAULT_SETTINGS.service, defaultSettings.service, userSettings.service)
	merged.toolSandbox = mergeToolSandboxSettings(DEFAULT_SETTINGS.toolSandbox, defaultSettings.toolSandbox, userSettings.toolSandbox)
	merged.defaultModel = mergeDefaultModel(defaultSettings, userSettings)
	merged.thinkingLevel = normalizeReasoningLevel(merged.thinkingLevel) ?? DEFAULT_SETTINGS.thinkingLevel
	if (typeof merged.defaultModel !== "string" || !merged.defaultModel) merged.defaultModel = DEFAULT_SETTINGS.defaultModel
	merged.updateCheck = typeof merged.updateCheck === "boolean" ? merged.updateCheck : DEFAULT_SETTINGS.updateCheck
	merged.buildFromSource = typeof merged.buildFromSource === "boolean" ? merged.buildFromSource : DEFAULT_SETTINGS.buildFromSource
	merged.showDeletedSessions = typeof merged.showDeletedSessions === "boolean" ? merged.showDeletedSessions : DEFAULT_SETTINGS.showDeletedSessions
	merged.showSubscriptionUsageStatus = showSubscriptionUsageStatusFromSettings(merged)
	return merged
}

/** @param {Pick<Settings, "toolSandbox"> | undefined} settings */
export function stateMountFromSettings(settings) {
	return normalizeStateMount(settings?.toolSandbox?.stateMount) ?? false
}

/** @returns {Settings} */
export function loadSettingsSync() {
	return mergeSettings(readSettingsFileSync(defaultSettingsPath()), readSettingsFileSync(settingsPath()))
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
	return mergeSettings(await readSettingsFile(defaultSettingsPath()), await readSettingsFile(settingsPath()))
}

/** @param {Pick<Settings, "defaultModel">} settings */
export function defaultModelRef(settings) {
	return settings.defaultModel
}

/**
 * @param {Settings} settings
 * @returns {{ showThinkingOutput: boolean, showToolOutput: boolean }}
 */
export function messageRenderOptionsFromSettings(settings) {
	void settings
	// These settings are accepted and persisted for future use, but transcript rendering remains locked down until the behavior is tested again.
	return {
		showThinkingOutput: false,
		showToolOutput: false,
	}
}

function redactedStringRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return record
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [
		key,
		/^(authorization|proxy-authorization|x-api-key|api-key|openai-api-key|cookie|set-cookie)$/i.test(key) ? "[redacted]" : value,
	]))
}

function redactedProviderModelSettings(model) {
	if (!model || typeof model !== "object" || Array.isArray(model)) return model
	const next = { ...model }
	if (next.headers) next.headers = redactedStringRecord(next.headers)
	return next
}

function redactedProviderSettings(provider) {
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) return provider
	const next = { ...provider }
	delete next.apiKey
	if (next.headers) next.headers = redactedStringRecord(next.headers)
	if (Array.isArray(next.models)) next.models = next.models.map(redactedProviderModelSettings)
	if (next.modelOverrides && typeof next.modelOverrides === "object" && !Array.isArray(next.modelOverrides)) {
		next.modelOverrides = Object.fromEntries(Object.entries(next.modelOverrides).map(([id, model]) => [id, redactedProviderModelSettings(model)]))
	}
	return next
}

/**
 * Return a browser-safe settings view. The Web UI needs model and display metadata, but not credentials or deployment capability tokens.
 * @param {Settings} settings
 * @returns {Settings}
 */
export function redactedSettings(settings) {
	const next = { ...settings }
	next.providers = Object.fromEntries(Object.entries(plainObject(settings.providers)).map(([id, provider]) => [id, redactedProviderSettings(provider)]))
	if (settings.service && typeof settings.service === "object") {
		next.service = { ...settings.service }
		delete next.service.token
		if (settings.service.web && typeof settings.service.web === "object") {
			next.service.web = { ...settings.service.web }
			delete next.service.web.token
			delete next.service.web.auth
		}
	}
	return next
}

/**
 * @param {Partial<Settings>} settings
 * @returns {Promise<void>}
 */
async function writeUserSettings(settings) {
	const path = settingsPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(settings, null, 2))
}

/**
 * @param {Settings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
	await writeUserSettings(settingsForWrite(settings, settings))
}

/**
 * Read-modify-write a settings patch. This writes only settings.json.
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function updateSettings(patch) {
	const userSettings = await readSettingsFile(settingsPath())
	const defaultSettings = await readSettingsFile(defaultSettingsPath())
	const current = mergeSettings(defaultSettings, userSettings)
	await writeUserSettings(settingsForWrite({ ...userSettings, ...patch }, current))
	return loadSettings()
}

/**
 * Read-modify-write a single setting. Returns the new full settings object.
 * @template {keyof Settings} K
 * @param {K} key
 * @param {Settings[K]} value
 * @returns {Promise<Settings>}
 */
export async function updateSetting(key, value) {
	return updateSettings({ [key]: value })
}
