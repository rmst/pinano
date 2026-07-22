export const BASH_SHORTCUT_CUSTOM_TYPE = "bash_shortcut"
export const BASH_SHORTCUT_MESSAGE_ROLE = "bashShortcut"

/** @param {unknown} value */
const stringOrEmpty = (value) => typeof value === "string" ? value : ""

/** @param {unknown} value */
const numberOrUndefined = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined

/** @param {unknown} value */
const timestampMs = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) return value
	const ms = Date.parse(String(value ?? ""))
	return Number.isFinite(ms) ? ms : Date.now()
}

/** @param {unknown} value */
const objectOrUndefined = (value) =>
	value && typeof value === "object" && !Array.isArray(value) ? value : undefined

/**
 * @typedef {object} BashShortcutEntryData
 * @property {number} version
 * @property {string} command
 * @property {string} output
 * @property {number} [exitCode]
 * @property {boolean} excludeFromContext
 * @property {string} recordedAt
 * @property {Record<string, unknown>} [details]
 */

/**
 * @param {unknown} value
 * @returns {BashShortcutEntryData | null}
 */
export function normalizeBashShortcutEntryData(value) {
	const data = objectOrUndefined(value)
	const command = stringOrEmpty(data?.command).trim()
	if (!command) return null
	const output = stringOrEmpty(data?.output)
	const recordedAt = stringOrEmpty(data?.recordedAt) || new Date().toISOString()
	return {
		version: 1,
		command,
		output,
		exitCode: numberOrUndefined(data?.exitCode),
		excludeFromContext: data?.excludeFromContext === true,
		recordedAt,
		...(objectOrUndefined(data?.details) ? { details: data.details } : {}),
	}
}

/**
 * @param {BashShortcutEntryData} shortcut
 * @returns {string}
 */
export function bashShortcutCommandLine(shortcut) {
	return `$ ${shortcut.command}${shortcut.excludeFromContext ? " (no-ctx)" : ""}`
}

/**
 * @param {BashShortcutEntryData} shortcut
 * @returns {string}
 */
export function bashShortcutDisplayText(shortcut) {
	return [bashShortcutCommandLine(shortcut), shortcut.output].filter((part) => part !== "").join("\n")
}

/**
 * @param {BashShortcutEntryData} shortcut
 * @returns {string}
 */
export function bashShortcutModelText(shortcut) {
	return `[user ran shell command]\n$ ${shortcut.command}\n${shortcut.output}`
}

/**
 * @param {BashShortcutEntryData} shortcut
 * @returns {any}
 */
export function bashShortcutDisplayMessage(shortcut) {
	return {
		role: BASH_SHORTCUT_MESSAGE_ROLE,
		content: [{ type: "text", text: bashShortcutDisplayText(shortcut) }],
		timestamp: timestampMs(shortcut.recordedAt),
		isError: typeof shortcut.exitCode === "number" && shortcut.exitCode !== 0,
		bashShortcut: {
			command: shortcut.command,
			output: shortcut.output,
			exitCode: shortcut.exitCode,
			excludeFromContext: shortcut.excludeFromContext,
			...(shortcut.details ? { details: shortcut.details } : {}),
		},
	}
}

/**
 * @param {BashShortcutEntryData} shortcut
 * @returns {any | null}
 */
export function bashShortcutModelMessage(shortcut) {
	if (shortcut.excludeFromContext) return null
	return {
		role: "user",
		content: [{ type: "text", text: bashShortcutModelText(shortcut) }],
		timestamp: timestampMs(shortcut.recordedAt),
	}
}

/**
 * @param {any} entry
 * @returns {any | null}
 */
export function bashShortcutDisplayMessageForEntry(entry) {
	if (entry?.type !== "custom" || entry.customType !== BASH_SHORTCUT_CUSTOM_TYPE) return null
	const shortcut = normalizeBashShortcutEntryData(entry.data)
	return shortcut ? bashShortcutDisplayMessage(shortcut) : null
}

/**
 * @param {any} entry
 * @returns {any | null}
 */
export function bashShortcutModelMessageForEntry(entry) {
	if (entry?.type !== "custom" || entry.customType !== BASH_SHORTCUT_CUSTOM_TYPE) return null
	const shortcut = normalizeBashShortcutEntryData(entry.data)
	return shortcut ? bashShortcutModelMessage(shortcut) : null
}

/** @param {any} entry */
export function bashShortcutOverviewMessageForEntry(entry) {
	const message = bashShortcutDisplayMessageForEntry(entry)
	if (!message) return undefined
	return {
		role: BASH_SHORTCUT_MESSAGE_ROLE,
		content: [{ type: "text", text: bashShortcutCommandLine(message.bashShortcut) }],
	}
}

/** @param {any} entry */
export function bashShortcutSummaryForEntry(entry) {
	const shortcut = normalizeBashShortcutEntryData(entry?.data)
	return shortcut ? `bash: ${shortcut.command}` : "bash shortcut"
}
