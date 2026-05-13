// User-level settings persisted to settings.json.
// Read once at startup; updates write through under a file lock.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { settingsPath } from "./paths.ts"

/** @typedef {"off" | "minimal" | "low" | "medium" | "high"} ThinkingLevel */

export interface Settings {
	model: string
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high"
	autoResume: boolean
	scopedModelIds: string[]
	autocompactThreshold: number
	doubleEscapeAction: "tree" | "fork" | "none"
}

export const DEFAULT_SETTINGS: Settings = {
	model: "openai-codex/gpt-5.5",
	thinkingLevel: "medium",
	// Default off — matches COMPARISON.md "Default = no auto-resume". Toggle
	// via /settings if you want -r behavior to be the default.
	autoResume: false,
	scopedModelIds: ["openai-codex/gpt-5.5", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-chat-latest"],
	autocompactThreshold: 0.85,
	doubleEscapeAction: "fork",
}

export async function loadSettings(): Promise<Settings> {
	try {
		const text = await readFile(settingsPath(), "utf-8")
		const parsed = JSON.parse(text) as Partial<Settings>
		return { ...DEFAULT_SETTINGS, ...parsed }
	} catch (err: any) {
		if (err.code === "ENOENT") return { ...DEFAULT_SETTINGS }
		throw err
	}
}

export async function saveSettings(settings: Settings): Promise<void> {
	const path = settingsPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(settings, null, 2))
}

/**
 * Read-modify-write a single setting. Returns the new full settings object.
 */
export async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings> {
	const current = await loadSettings()
	const next = { ...current, [key]: value }
	await saveSettings(next)
	return next
}
