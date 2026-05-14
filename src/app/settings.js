// User-level settings persisted to settings.json.
// Read once at startup; updates write through under a file lock.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { settingsPath } from "./paths.js"

/** @typedef {"off" | "minimal" | "low" | "medium" | "high"} ThinkingLevel */

/**
 * @typedef {object} Settings
 * @property {string} model
 * @property {"off" | "minimal" | "low" | "medium" | "high"} thinkingLevel
 * @property {boolean} autoResume
 * @property {string[]} scopedModelIds
 * @property {number} autocompactThreshold
 * @property {"tree" | "fork" | "none"} doubleEscapeAction
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
	model: "openai-codex/gpt-5.5",
	thinkingLevel: "medium",
	// Default off — matches COMPARISON.md "Default = no auto-resume". Toggle
	// via /settings if you want -r behavior to be the default.
	autoResume: false,
	scopedModelIds: ["openai-codex/gpt-5.5", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-chat-latest"],
	autocompactThreshold: 0.85,
	doubleEscapeAction: "fork",
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
	try {
		const text = await readFile(settingsPath(), "utf-8")
		const parsed = /** @type {Partial<Settings>} */ (JSON.parse(text))
		return { ...DEFAULT_SETTINGS, ...parsed }
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return { ...DEFAULT_SETTINGS }
		throw err
	}
}

/**
 * @param {Settings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
	const path = settingsPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(settings, null, 2))
}

/**
 * Read-modify-write a single setting. Returns the new full settings object.
 * @template {keyof Settings} K
 * @param {K} key
 * @param {Settings[K]} value
 * @returns {Promise<Settings>}
 */
export async function updateSetting(key, value) {
	const current = await loadSettings()
	const next = { ...current, [key]: value }
	await saveSettings(next)
	return next
}
