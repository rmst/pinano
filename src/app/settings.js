// User-level settings persisted to settings.json.
// Read once at startup; updates write through under a file lock.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { normalizeReasoningLevel } from "../reasoning.js"
import { defaultSettingsPath, settingsPath } from "./paths.js"

/** @typedef {import("../reasoning.js").ReasoningLevel} ThinkingLevel */

/**
 * @typedef {object} ModelSettings
 * @property {string} [extends]
 * @property {string} [displayName]
 * @property {"openai" | "openai-codex" | "llamacpp" | "moonshot" | "deepseek"} [provider]
 * @property {"openai" | "openai-codex" | "llamacpp" | "moonshot" | "deepseek"} [authProvider]
 * @property {string} [baseUrl]
 * @property {string} [wireModel]
 * @property {boolean} [reasoning]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} [cost]
 * @property {("text" | "image")[]} [input]
 * @property {Record<string, unknown>} [compat]
 * @property {{ implicitResponses?: boolean }} [compaction]
 * @property {"chat" | "responses"} [transport]
 * @property {"default" | "apply_patch"} [toolProfile]
 * @property {string[]} [tags]
 */

/**
 * @typedef {object} Settings
 * @property {string} model
 * @property {Record<string, ModelSettings>} models
 * @property {ThinkingLevel} thinkingLevel
 * @property {string[]} scopedModelIds
 * @property {number} autocompactThreshold
 * @property {"rewind" | "none"} doubleEscapeAction
 * @property {boolean} web
 * @property {boolean} showThinkingOutput
 * @property {boolean} showToolOutput
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
	model: "openai-codex/gpt-5.5",
	models: {},
	thinkingLevel: "high",
	scopedModelIds: ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini", "gpt-5.5", "gpt-5.4-mini"],
	autocompactThreshold: 0.85,
	doubleEscapeAction: "rewind",
	web: false,
	showThinkingOutput: false,
	showToolOutput: false,
}

const SETTING_KEYS = /** @type {const} */ ([
	"model",
	"models",
	"thinkingLevel",
	"scopedModelIds",
	"autocompactThreshold",
	"doubleEscapeAction",
	"web",
	"showThinkingOutput",
	"showToolOutput",
])

/**
 * @param {string} path
 * @returns {Promise<Partial<Settings>>}
 */
async function readSettingsFile(path) {
	try {
		const text = await readFile(path, "utf-8")
		const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(text))
		/** @type {Partial<Settings>} */
		const settings = {}
		for (const key of SETTING_KEYS) {
			if (Object.hasOwn(parsed, key)) settings[key] = /** @type {any} */ (parsed[key])
		}
		return settings
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return {}
		throw err
	}
}

function plainObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function mergeModelSettings(...sources) {
	const merged = {}
	for (const source of sources) {
		for (const [id, config] of Object.entries(plainObject(source))) {
			if (config && typeof config === "object" && !Array.isArray(config)) merged[id] = { ...(merged[id] ?? {}), ...config }
		}
	}
	return merged
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
	const defaultSettings = await readSettingsFile(defaultSettingsPath())
	const userSettings = await readSettingsFile(settingsPath())
	const merged = { ...DEFAULT_SETTINGS, ...defaultSettings, ...userSettings }
	merged.models = mergeModelSettings(DEFAULT_SETTINGS.models, defaultSettings.models, userSettings.models)
	merged.thinkingLevel = normalizeReasoningLevel(merged.thinkingLevel) ?? DEFAULT_SETTINGS.thinkingLevel
	if (merged.doubleEscapeAction === "fork" || merged.doubleEscapeAction === "tree") merged.doubleEscapeAction = "rewind"
	return merged
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
	await writeUserSettings(settings)
}

/**
 * Read-modify-write a single setting. Returns the new full settings object.
 * @template {keyof Settings} K
 * @param {K} key
 * @param {Settings[K]} value
 * @returns {Promise<Settings>}
 */
export async function updateSetting(key, value) {
	const userSettings = await readSettingsFile(settingsPath())
	await writeUserSettings({ ...userSettings, [key]: value })
	return loadSettings()
}
