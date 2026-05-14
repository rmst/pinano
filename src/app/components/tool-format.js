// Concise one-line formatters for known tool calls. Mirrors pi's
// `formatXxxCall` helpers (one per tool) — but inlined here as a single
// dispatch table so we don't need to wire up pi's full ToolDefinition surface
// (renderCall/renderResult/etc., per COMPARISON.md "won't add").
//
// Format: `<bold tool name> <accent arg>` plus optional dim suffix for
// secondary args (limit, timeout, glob, line range). Unknown tools fall back
// to JSON dump — same as pi's `formatToolExecution` fallback.

import { homedir } from "node:os"
import { theme } from "../theme.js"

const HOME = homedir()

/**
 * @param {string} p
 * @returns {string}
 */
function shorten(p) {
	if (typeof p !== "string" || !p) return ""
	if (HOME && p.startsWith(HOME)) return "~" + p.slice(HOME.length)
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
 * @param {string} name
 * @returns {string}
 */
function title(name) {
	return theme.bold(theme.fg("toolTitle", name))
}

/**
 * @param {string} s
 * @returns {string}
 */
function arg(s) {
	return theme.fg("accent", s)
}

/**
 * @param {string} s
 * @returns {string}
 */
function dimNote(s) {
	return theme.fg("muted", s)
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtRead(args) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(shorten(path)) : dimNote("...")
	let out = `${title("read")} ${display}`
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
function fmtWrite(args) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(shorten(path)) : dimNote("...")
	return `${title("write")} ${display}`
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtEdit(args) {
	const path = pickStr(args?.file_path, args?.path)
	const display = path === null ? dimNote("(missing path)") : path ? arg(shorten(path)) : dimNote("...")
	return `${title("edit")} ${display}`
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtBash(args) {
	const cmd = pickStr(args?.command)
	const timeout = args?.timeout
	const display = cmd === null ? dimNote("(missing command)") : cmd ? cmd : dimNote("...")
	let out = title(`$ ${display}`)
	if (typeof timeout === "number") out += dimNote(` (timeout ${timeout}s)`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtLs(args) {
	const path = pickStr(args?.path) ?? "."
	let out = `${title("ls")} ${arg(shorten(path))}`
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtGrep(args) {
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	let out = `${title("grep")} ${pattern === null ? dimNote("(missing pattern)") : arg(pattern)} ${shorten(path)}`
	const glob = pickStr(args?.glob)
	if (glob) out += dimNote(` --glob ${glob}`)
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/**
 * @param {any} args
 * @returns {string}
 */
function fmtFind(args) {
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	let out = `${title("find")} ${pattern === null ? dimNote("(missing pattern)") : arg(pattern)} ${shorten(path)}`
	if (typeof args?.limit === "number") out += dimNote(` (limit ${args.limit})`)
	return out
}

/** @type {Record<string, (args: any) => string>} */
const REGISTRY = {
	read: fmtRead,
	write: fmtWrite,
	edit: fmtEdit,
	bash: fmtBash,
	ls: fmtLs,
	grep: fmtGrep,
	find: fmtFind,
}

/**
 * Render a tool-call header. Returns just the title line — callers append
 * args/result rendering as needed. For unknown tools, returns the JSON
 * arg dump so the user can still see what's happening (the pi fallback path).
 *
 * @param {string} name
 * @param {any} args
 * @returns {{ line: string, jsonFallback: boolean }}
 */
export function formatToolCall(name, args) {
	const fmt = REGISTRY[name]
	if (fmt) return { line: fmt(args), jsonFallback: false }
	const stripped = `${title(name)}`
	return { line: stripped, jsonFallback: true }
}
