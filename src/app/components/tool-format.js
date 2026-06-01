// Concise one-line formatters for known tool calls. Mirrors pi's
// `formatXxxCall` helpers (one per tool) — but inlined here as a single
// dispatch table so we don't need to wire up pi's full ToolDefinition surface
// (renderCall/renderResult/etc.).
//
// Format: `<bold tool name> <quiet arg>` plus optional dim suffix for
// secondary args (limit, timeout, glob, line range). Unknown tools show an
// inline JSON arg dump so every tool-call header remains one terminal row.

import { homedir } from "node:os"
import { formatSessionWriteSummary } from "../session-write-summary.js"
import { theme } from "../theme.js"

const HOME = homedir()

/** @typedef {"pending" | "success" | "error"} ToolCallState */
/** @typedef {{ state?: ToolCallState }} ToolCallFormatOptions */

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
 * @param {...any} candidates
 * @returns {string | null}
 */
function pickStr(...candidates) {
	for (const c of candidates) {
		if (typeof c === "string") return c
	}
	return null
}

/**
 * @param {ToolCallState | undefined} state
 * @returns {"toolTitle" | "toolTitleSuccess" | "toolTitleError"}
 */
function titleToken(state) {
	if (state === "success") return "toolTitleSuccess"
	if (state === "error") return "toolTitleError"
	return "toolTitle"
}

/**
 * @param {string} name
 * @param {ToolCallFormatOptions} [options]
 * @returns {string}
 */
function title(name, options = {}) {
	return theme.bold(theme.fg(titleToken(options.state), name))
}

/**
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
	return s.replace(/\s+/g, " ").trim()
}

/**
 * @param {string} s
 * @returns {string}
 */
function arg(s) {
	return theme.fg("toolArg", s)
}

/**
 * @param {string} s
 * @returns {string}
 */
function dimNote(s) {
	return theme.fg("toolText", s)
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtRead(args, options) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(formatToolPath(path)) : dimNote("...")
	let out = `${title("read", options)} ${display}`
	const offset = args?.offset
	const limit = args?.limit
	if (typeof offset === "number" || typeof limit === "number") {
		const start = typeof offset === "number" ? offset + 1 : 1
		if (typeof limit === "number") out += dimNote(` lines ${start}-${start + limit - 1}`)
		else out += dimNote(` from line ${start}`)
	}
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtWrite(args, options) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(formatToolPath(path)) : dimNote("...")
	return `${title("write", options)} ${display}`
}

/**
 * @param {any} input
 * @param {ToolCallFormatOptions} [options]
 * @returns {string}
 */
function fmtApplyPatch(input, options) {
	const text = typeof input === "string" ? input : ""
	const files = [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File): (.+)$/gm)].map((match) => formatToolPath(match[1]))
	const suffix = files.length > 0 ? arg(files.slice(0, 3).join(", ")) : dimNote("...")
	const more = files.length > 3 ? dimNote(` +${files.length - 3} more`) : ""
	return `${title("edit", options)} ${suffix}${more}`
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtEdit(args, options) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(formatToolPath(path)) : dimNote("...")
	return `${title("edit", options)} ${display}`
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtBash(args, options) {
	const cmd = pickStr(args?.command)
	const timeout = args?.timeout
	const display = cmd === null ? dimNote("(missing command)") : cmd ? arg(oneLine(cmd)) : dimNote("...")
	let out = `${title("$", options)} ${display}`
	if (typeof timeout === "number") out += dimNote(` (timeout ${timeout}s)`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtLs(args, options) {
	const path = pickStr(args?.path) ?? "."
	let out = `${title("ls", options)} ${arg(formatToolPath(path))}`
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtGrep(args, options) {
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	let out = `${title("grep", options)} ${pattern === null ? dimNote("(missing pattern)") : arg(pattern)} ${arg(formatToolPath(path))}`
	const glob = pickStr(args?.glob)
	if (glob) out += dimNote(` --glob ${glob}`)
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtFind(args, options) {
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	let out = `${title("find", options)} ${pattern === null ? dimNote("(missing pattern)") : arg(pattern)} ${arg(formatToolPath(path))}`
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtJs(args, options) {
	const code = pickStr(args?.code)
	const display = code === null ? dimNote("(missing code)") : code ? oneLine(code) : dimNote("...")
	return `${title("js", options)} ${arg(display.length > 100 ? `${display.slice(0, 100)}…` : display)}`
}

function fmtSessionSet(args, options) {
	return `${title("session", options)} ${arg(formatSessionWriteSummary(args, { formatPath: formatToolPath }))}`
}

/** @type {Record<string, (args: any, options: ToolCallFormatOptions) => string>} */
const REGISTRY = {
	read: fmtRead,
	write: fmtWrite,
	apply_patch: fmtApplyPatch,
	edit: fmtEdit,
	bash: fmtBash,
	ls: fmtLs,
	grep: fmtGrep,
	find: fmtFind,
	js: fmtJs,
	sessionWrite: fmtSessionSet,
}

/**
 * @param {any} args
 * @returns {string}
 */
function inlineJson(args) {
	if (args === undefined || args === null) return ""
	try {
		const json = JSON.stringify(args)
		return json === "{}" ? "" : json
	} catch {
		return oneLine(String(args))
	}
}

/**
 * Render a tool-call header. Returns a single title line; callers append
 * result rendering as needed. For unknown tools, includes a compact inline
 * arg dump so the user can still see what's happening.
 *
 * @param {string} name
 * @param {any} args
 * @param {ToolCallFormatOptions} [options]
 * @returns {{ line: string }}
 */
export function formatToolCall(name, args, options = {}) {
	const fmt = REGISTRY[name]
	if (fmt) return { line: fmt(args, options) }
	const json = inlineJson(args)
	const suffix = json ? ` ${dimNote(json)}` : ""
	return { line: `${title(name, options)}${suffix}` }
}
