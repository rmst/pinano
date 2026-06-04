// Settings persisted under $PINANO_HOME.
//
// default-settings.json is launcher/deployment-owned and never written here.
// settings.json is the user override layer and is the only file update paths
// mutate. Runtime code reads the merged view: built-ins < defaults < user.

import { readFileSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { normalizeReasoningLevel } from "../reasoning.js"
import { defaultSettingsPath, legacyDefaultSettingsPath, legacySettingsPath, settingsPath } from "./paths.js"

/** @typedef {import("../reasoning.js").ReasoningLevel} ThinkingLevel */

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
 * @property {"chat" | "responses"} [transport]
 * @property {string} [maintenanceModelRef]
 * @property {"default" | "codex"} [toolProfile]
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
 * @property {ProviderModelSettings[]} [models]
 * @property {Record<string, ProviderModelSettings>} [modelOverrides]
 */

/**
 * @typedef {object} ServiceSettings
 * @property {string} [worker]
 * @property {boolean | string} [modelIoLog]
 * @property {string} [modelIoLogDb]
 * @property {string} [token]
 * @property {{ host?: string, port?: number | string, token?: string, publicUrl?: string, dev?: boolean }} [web]
 * @property {boolean | string | Record<string, unknown>} [diagnostics]
 */

/**
 * @typedef {object} Settings
 * @property {string} defaultModel
 * @property {Record<string, ProviderSettings>} providers
 * @property {ServiceSettings} service
 * @property {ThinkingLevel} thinkingLevel
 * @property {string[]} scopedModelIds
 * @property {number} autocompactThreshold
 * @property {"rewind" | "none"} doubleEscapeAction
 * @property {boolean} web
 * @property {boolean} showThinkingOutput
 * @property {boolean} showToolOutput
 */

/** @typedef {Partial<Settings> & { defaultProvider?: string }} RawSettings */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
	defaultModel: "openai-codex/gpt-5.5",
	providers: {},
	service: {},
	thinkingLevel: "high",
	scopedModelIds: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini", "openai/gpt-5.5", "openai/gpt-5.4-mini"],
	autocompactThreshold: 0.85,
	doubleEscapeAction: "rewind",
	web: false,
	showThinkingOutput: false,
	showToolOutput: false,
}

const SETTING_KEYS = /** @type {const} */ ([
	"defaultProvider",
	"defaultModel",
	"providers",
	"service",
	"thinkingLevel",
	"scopedModelIds",
	"autocompactThreshold",
	"doubleEscapeAction",
	"web",
	"showThinkingOutput",
	"showToolOutput",
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
 * @returns {RawSettings | undefined}
 */
function readSettingsFileMaybeSync(path) {
	try {
		const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf-8")))
		return pickSettingsKeys(parsed)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

/**
 * @param {string} path
 * @param {string} legacyPath
 * @returns {RawSettings}
 */
function readSettingsLayerSync(path, legacyPath) {
	return { ...(readSettingsFileMaybeSync(legacyPath) ?? {}), ...(readSettingsFileMaybeSync(path) ?? {}) }
}

/**
 * @param {string} path
 * @returns {Promise<RawSettings | undefined>}
 */
async function readSettingsFileMaybe(path) {
	try {
		const text = await readFile(path, "utf-8")
		const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(text))
		return pickSettingsKeys(parsed)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return undefined
		throw err
	}
}

/**
 * @param {string} path
 * @param {string} legacyPath
 * @returns {Promise<RawSettings>}
 */
async function readSettingsLayer(path, legacyPath) {
	return { ...(await readSettingsFileMaybe(legacyPath) ?? {}), ...(await readSettingsFileMaybe(path) ?? {}) }
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
function cleanModelSettings(value) {
	const model = plainObject(value)
	if (Object.keys(model).length === 0) return undefined
	const out = {}
	for (const key of ["id", "extends", "displayName", "authProvider", "baseUrl", "wireModel", "maintenanceModelRef", "toolProfile", "transport"]) {
		if (typeof model[key] === "string" && model[key]) out[key] = model[key]
	}
	if (typeof model.reasoning === "boolean") out.reasoning = model.reasoning
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
	const tags = stringArray(model.tags)
	if (tags) out.tags = tags
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
	for (const key of ["worker", "modelIoLogDb", "token"]) {
		if (typeof raw[key] === "string" && raw[key]) out[key] = raw[key]
	}
	if (typeof raw.modelIoLog === "boolean" || typeof raw.modelIoLog === "string") out.modelIoLog = raw.modelIoLog
	const web = plainObject(raw.web)
	if (Object.keys(web).length > 0) {
		out.web = {}
		for (const key of ["host", "token", "publicUrl"]) {
			if (typeof web[key] === "string" && web[key]) out.web[key] = web[key]
		}
		if (typeof web.port === "number" || typeof web.port === "string") out.web.port = web.port
		if (web.dev === true) out.web.dev = true
	}
	if (typeof raw.diagnostics === "boolean" || typeof raw.diagnostics === "string") out.diagnostics = raw.diagnostics
	else {
		const diagnostics = plainObject(raw.diagnostics)
		if (Object.keys(diagnostics).length > 0) out.diagnostics = diagnostics
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
		const diagnostics = service.diagnostics
		Object.assign(merged, service)
		if (web) merged.web = { ...(merged.web ?? {}), ...web }
		if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
			merged.diagnostics = { ...(typeof merged.diagnostics === "object" && !Array.isArray(merged.diagnostics) ? merged.diagnostics : {}), ...diagnostics }
		}
	}
	return merged
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

/** @param {string} ref */
function defaultModelId(ref) {
	return splitDefaultModelRef(ref).id
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
		const provider = typeof source?.defaultProvider === "string" && source.defaultProvider.trim() ? source.defaultProvider.trim() : undefined
		const model = typeof source?.defaultModel === "string" && source.defaultModel.trim() ? source.defaultModel.trim() : undefined
		if (model) current = normalizeDefaultModelRef(model, provider ?? defaultModelProvider(current)) ?? current
		else if (provider) current = normalizeDefaultModelRef(defaultModelId(current), provider) ?? current
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
	const provider = typeof out.defaultProvider === "string" && out.defaultProvider.trim() ? out.defaultProvider.trim() : undefined
	const model = typeof out.defaultModel === "string" && out.defaultModel.trim() ? out.defaultModel.trim() : undefined
	delete out.defaultProvider
	if (model) out.defaultModel = normalizeDefaultModelRef(model, provider ?? defaultModelProvider(current.defaultModel))
	else {
		delete out.defaultModel
		if (provider) out.defaultModel = normalizeDefaultModelRef(defaultModelId(current.defaultModel), provider)
	}
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
	merged.defaultModel = mergeDefaultModel(defaultSettings, userSettings)
	merged.thinkingLevel = normalizeReasoningLevel(merged.thinkingLevel) ?? DEFAULT_SETTINGS.thinkingLevel
	if (merged.doubleEscapeAction === "fork" || merged.doubleEscapeAction === "tree") merged.doubleEscapeAction = "rewind"
	if (typeof merged.defaultModel !== "string" || !merged.defaultModel) merged.defaultModel = DEFAULT_SETTINGS.defaultModel
	merged.scopedModelIds = stringArray(merged.scopedModelIds) ?? DEFAULT_SETTINGS.scopedModelIds
	delete merged.defaultProvider
	return merged
}

/** @returns {Settings} */
export function loadSettingsSync() {
	return mergeSettings(
		readSettingsLayerSync(defaultSettingsPath(), legacyDefaultSettingsPath()),
		readSettingsLayerSync(settingsPath(), legacySettingsPath()),
	)
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
	return mergeSettings(
		await readSettingsLayer(defaultSettingsPath(), legacyDefaultSettingsPath()),
		await readSettingsLayer(settingsPath(), legacySettingsPath()),
	)
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
	return {
		showThinkingOutput: settings.showThinkingOutput,
		showToolOutput: settings.showToolOutput,
	}
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
	const userSettings = await readSettingsLayer(settingsPath(), legacySettingsPath())
	const defaultSettings = await readSettingsLayer(defaultSettingsPath(), legacyDefaultSettingsPath())
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
