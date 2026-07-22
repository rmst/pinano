import { decodePrintableKey, isKeyRelease, matchesKey } from "../../tui/index.js"

const DOUBLE_ESCAPE_MS = 500

export class DoubleEscapeTracker {
	/** @param {number} [timeoutMs] */
	constructor(timeoutMs = DOUBLE_ESCAPE_MS) {
		this.timeoutMs = timeoutMs
		this.lastPressAt = undefined
	}

	reset() {
		this.lastPressAt = undefined
	}

	/** @param {number} [now] */
	press(now = Date.now()) {
		if (this.lastPressAt !== undefined && now - this.lastPressAt < this.timeoutMs) {
			this.reset()
			return true
		}
		this.lastPressAt = now
		return false
	}
}

/** @param {string} data */
export function matchesRouteBackShortcut(data) {
	return matchesKey(data, "alt+left")
		|| matchesKey(data, "super+left")
		|| matchesKey(data, "super+[")
}

/** @param {string} data */
export function matchesRouteForwardShortcut(data) {
	return matchesKey(data, "alt+right")
		|| matchesKey(data, "super+right")
		|| matchesKey(data, "super+]")
}

/** @param {{ focused: boolean }} state */
export function routeHistoryShortcutAllowed({ focused }) {
	return !focused
}

/** @param {{ text: string }} state */
export function sessionPageBackShortcutAllowed({ text }) {
	return text.trim() === ""
}

/** @param {string} data */
export function isEditorTextInput(data) {
	return data.includes("\x1b[200~")
		|| decodePrintableKey(data) !== undefined
		|| (data.length > 0 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32)
}
