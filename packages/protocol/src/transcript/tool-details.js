import { normalizedToolName } from "./tool-format.js"

/**
 * @param {any} value
 * @returns {string}
 */
export function prettyToolValue(value) {
	if (value === undefined) return "(none)"
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value, null, "\t") ?? String(value)
	} catch {
		return String(value)
	}
}

/**
 * @param {any} block
 * @returns {string}
 */
function imageBlockDescription(block) {
	const mime = typeof block?.mimeType === "string" && block.mimeType ? block.mimeType : "image"
	const size = typeof block?.widthPx === "number" && typeof block?.heightPx === "number"
		? ` ${block.widthPx}x${block.heightPx}`
		: ""
	const detail = typeof block?.detail === "string" && block.detail ? ` detail=${block.detail}` : ""
	const bytes = typeof block?.data === "string" ? ` ${block.data.length} base64 chars` : ""
	return `[${mime}${size}${detail}${bytes}]`
}

/**
 * @param {any} block
 * @returns {string}
 */
function contentBlockText(block) {
	if (block?.type === "text") return String(block.text ?? "")
	if (block?.type === "image") return imageBlockDescription(block)
	return prettyToolValue(block)
}

/**
 * @param {any} content
 * @returns {string}
 */
export function toolResultContentText(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.map(contentBlockText).filter((text) => text.length > 0).join("\n")
}

/**
 * @param {any} result
 * @returns {string}
 */
function toolResultText(result) {
	if (!result) return ""
	return toolResultContentText(result.content)
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function hasMeaningfulValue(value) {
	if (value === undefined || value === null) return false
	if (typeof value === "string") return value.length > 0
	if (Array.isArray(value)) return value.length > 0
	if (typeof value === "object") return Object.keys(value).length > 0
	return true
}

/**
 * @param {object} options
 * @param {string | undefined} options.name
 * @param {string | undefined} [options.id]
 * @param {any} [options.args]
 * @param {any} [options.result]
 * @param {boolean} [options.isError]
 * @returns {string}
 */
export function formatExpandedToolDetails({ name, id, args, result, isError = false }) {
	const lines = [
		`tool: ${normalizedToolName(name)}`,
	]
	if (id) lines.push(`id: ${id}`)
	lines.push(typeof args === "string" ? "input:" : "arguments:")
	lines.push(prettyToolValue(args ?? {}))

	if (result) {
		lines.push("")
		lines.push(isError ? "result (error):" : "result:")
		lines.push(toolResultText(result) || "(no output)")
		if (hasMeaningfulValue(result.details)) {
			lines.push("details:")
			lines.push(prettyToolValue(result.details))
		}
	}

	return lines.join("\n")
}
