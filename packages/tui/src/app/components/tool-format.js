// Terminal-styled wrapper for the shared tool-call formatter.

import { homedir } from "node:os"

import { theme } from "../theme.js"
import { formatToolCallParts } from "../../../../protocol/src/transcript/tool-format.js"

const HOME = homedir()

/**
 * @param {string} p
 * @returns {string}
 */
export function formatToolPath(p) {
	if (typeof p !== "string" || !p) return ""
	if (HOME && p === HOME) return "~"
	if (HOME && p.startsWith(`${HOME}/`)) return "~" + p.slice(HOME.length)
	return p
}

/**
 * @param {"pending" | "success" | "error" | undefined} state
 * @returns {"toolTitle" | "toolTitleSuccess" | "toolTitleError"}
 */
function titleToken(state) {
	if (state === "success") return "toolTitleSuccess"
	if (state === "error") return "toolTitleError"
	return "toolTitle"
}

/**
 * @param {import("../../../../protocol/src/transcript/tool-format.js").ToolCallPart} part
 * @param {"pending" | "success" | "error" | undefined} state
 */
function renderPart(part, state) {
	if (part.kind === "title") return theme.bold(theme.fg(titleToken(state), part.text))
	if (part.kind === "arg") return theme.fg("toolArg", part.text)
	if (part.kind === "note") return theme.fg("toolText", part.text)
	return part.text
}

/**
 * Render a tool-call header. Returns a single title line; callers append
 * result rendering as needed.
 *
 * @param {string} name
 * @param {any} args
 * @param {{ state?: "pending" | "success" | "error" }} [options]
 * @returns {{ line: string }}
 */
export function formatToolCall(name, args, options = {}) {
	const { parts } = formatToolCallParts(name, args, { ...options, formatPath: formatToolPath })
	return { line: parts.map((part) => renderPart(part, options.state)).join("") }
}
