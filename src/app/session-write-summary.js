/** Pure display helpers for the Pinano sessionWrite tool. */

const STATE_LABELS = {
	readyForReview: "ready for review",
	needs_input: "needs input",
	completed: "completed",
	deferred: "deferred",
}

/** @param {any} value */
function hasValue(value) {
	return value !== undefined
}

/** @param {any} value */
function singleLine(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim()
}

/** @param {any} value @param {number} max */
function quoted(value, max = 90) {
	const text = singleLine(value)
	const clipped = text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text
	return JSON.stringify(clipped)
}

/** @param {any} obj @param {string} key */
function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * @param {any} args
 * @param {{ formatPath?: (path: string) => string, separator?: string }} [options]
 * @returns {string}
 */
export function formatSessionWriteSummary(args, options = {}) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "session update"
	const formatPath = options.formatPath ?? ((path) => path)
	const separator = options.separator ?? " · "
	const parts = []

	if (hasOwn(args, "state") && hasValue(args.state)) {
		if (args.state === null || args.state === "null") parts.push("session marked ready for review")
		else if (STATE_LABELS[args.state]) parts.push(`session marked ${STATE_LABELS[args.state]}`)
		else parts.push(`session state set to ${singleLine(args.state) || "unknown"}`)
	}
	if (hasOwn(args, "descriptionInUi") && hasValue(args.descriptionInUi)) {
		if (args.descriptionInUi === null) parts.push("description cleared")
		else parts.push(`description updated to ${quoted(args.descriptionInUi)}`)
	}
	if (hasOwn(args, "projectTag") && hasValue(args.projectTag)) {
		if (args.projectTag === null) parts.push("project cleared")
		else parts.push(`project set to ${singleLine(args.projectTag) || "unknown"}`)
	}
	if (hasOwn(args, "cwd") && hasValue(args.cwd)) parts.push(`cwd updated to ${formatPath(singleLine(args.cwd))}`)
	if (hasOwn(args, "environmentId") && hasValue(args.environmentId)) parts.push(`environment set to ${singleLine(args.environmentId) || "unknown"}`)

	return parts.length > 0 ? parts.join(separator) : "session update"
}
