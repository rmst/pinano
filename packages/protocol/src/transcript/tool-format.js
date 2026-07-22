// Pure tool-call header formatting shared by terminal and web renderers. This
// file knows the semantic shape of each tool call, but not how a renderer
// colors text or shortens local paths.

/** @typedef {"pending" | "success" | "error"} ToolCallState */
/** @typedef {"title" | "arg" | "note" | "plain"} ToolCallPartKind */
/** @typedef {{ kind: ToolCallPartKind, text: string }} ToolCallPart */
/** @typedef {{ state?: ToolCallState, formatPath?: (path: string) => string }} ToolCallFormatOptions */

/** @param {string} text @returns {ToolCallPart} */
const title = (text) => ({ kind: "title", text })
/** @param {string} text @returns {ToolCallPart} */
const arg = (text) => ({ kind: "arg", text })
/** @param {string} text @returns {ToolCallPart} */
const note = (text) => ({ kind: "note", text })
/** @param {string} text @returns {ToolCallPart} */
const plain = (text) => ({ kind: "plain", text })

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

/** @param {string} s */
function oneLine(s) {
	return s.replace(/\s+/g, " ").trim()
}

/** @param {ToolCallFormatOptions | undefined} options */
function pathFormatter(options) {
	return typeof options?.formatPath === "function" ? options.formatPath : (p) => p
}

/**
 * @param {string | null} value
 * @param {string} missing
 * @param {string} empty
 * @param {(value: string) => string} [format]
 * @returns {ToolCallPart}
 */
function valuePart(value, missing, empty, format = (v) => v) {
	if (value === null) return note(missing)
	if (value) return arg(format(value))
	return note(empty)
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtRead(args, options) {
	const formatPath = pathFormatter(options)
	const path = pickStr(args?.file_path, args?.path)
	const parts = [title("read"), plain(" "), valuePart(path, "(missing path)", "...", formatPath)]
	const offset = args?.offset
	const limit = args?.limit
	if (typeof offset === "number" || typeof limit === "number") {
		const start = typeof offset === "number" ? offset + 1 : 1
		parts.push(note(typeof limit === "number" ? ` lines ${start}-${start + limit - 1}` : ` from line ${start}`))
	}
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtWrite(args, options) {
	const formatPath = pathFormatter(options)
	const path = pickStr(args?.file_path, args?.path)
	return [title("write"), plain(" "), valuePart(path, "(missing path)", "...", formatPath)]
}

/**
 * @param {any} input
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtApplyPatch(input, options) {
	const formatPath = pathFormatter(options)
	const text = typeof input === "string" ? input : ""
	const files = [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File): (.+)$/gm)].map((match) => formatPath(match[1]))
	const parts = [title("edit"), plain(" "), files.length > 0 ? arg(files.slice(0, 3).join(", ")) : note("...")]
	if (files.length > 3) parts.push(note(` +${files.length - 3} more`))
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtEdit(args, options) {
	const formatPath = pathFormatter(options)
	const path = pickStr(args?.file_path, args?.path)
	return [title("edit"), plain(" "), valuePart(path, "(missing path)", "...", formatPath)]
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtBash(args, options) {
	const cmd = pickStr(args?.command)
	const parts = [title("$"), plain(" "), valuePart(cmd, "(missing command)", "...", oneLine)]
	if (typeof args?.timeout === "number") parts.push(note(` (timeout ${args.timeout}s)`))
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtExecCommand(args, options) {
	const formatPath = pathFormatter(options)
	const cmd = pickStr(args?.cmd)
	const parts = [title("exec"), plain(" "), valuePart(cmd, "(missing cmd)", "...", oneLine)]
	const notes = []
	if (typeof args?.yield_time_ms === "number") notes.push(`yield ${args.yield_time_ms}ms`)
	if (typeof args?.timeout_ms === "number") notes.push(`timeout ${args.timeout_ms}ms`)
	if (typeof args?.max_output_tokens === "number") notes.push(`max ${args.max_output_tokens}t`)
	if (typeof args?.interactive === "string" && args.interactive !== "none") notes.push(args.interactive)
	if (typeof args?.workdir === "string") notes.push(formatPath(args.workdir))
	if (notes.length > 0) parts.push(note(` (${notes.join(", ")})`))
	return parts
}

/** @param {string} source */
function firstExecCommand(source) {
	const marker = "tools.exec_command"
	const markerIndex = source.indexOf(marker)
	if (markerIndex === -1) return null
	const invocation = source.slice(markerIndex + marker.length)
	const match = /(?:^|[{,]\s*)(?:"cmd"|'cmd'|cmd)\s*:\s*("(?:\\[\s\S]|[^"\\])*")/.exec(invocation)
	if (!match) return null
	try {
		const command = JSON.parse(match[1])
		return typeof command === "string" ? command : null
	} catch {
		return null
	}
}

/**
 * @param {any} input
 * @param {ToolCallFormatOptions} _options
 * @returns {ToolCallPart[]}
 */
function fmtExec(input, _options) {
	const source = typeof input === "string" ? input : ""
	if (!source) return [title("exec"), plain(" "), note("...")]
	const command = firstExecCommand(source)
	return [title("exec"), plain(" "), arg(command === null ? oneLine(source) : `... ${oneLine(command)}`)]
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} _options
 * @returns {ToolCallPart[]}
 */
function fmtWriteStdin(args, _options) {
	const rawSessionId = args?.session_id
	const sessionId = typeof rawSessionId === "number" && Number.isInteger(rawSessionId) ? String(rawSessionId) : pickStr(rawSessionId)
	const actions = []
	if (typeof args?.chars === "string" && args.chars.length > 0) actions.push(`${args.chars.length} chars`)
	if (args?.close_stdin === true) actions.push("close stdin")
	if (typeof args?.signal === "string") actions.push(args.signal)
	if (actions.length === 0) actions.push("poll")
	return [
		title("write_stdin"),
		plain(" "),
		sessionId === null ? note("(missing session_id)") : arg(sessionId),
		note(` (${actions.join(", ")})`),
	]
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtLs(args, options) {
	const formatPath = pathFormatter(options)
	const path = pickStr(args?.path) ?? "."
	const parts = [title("ls"), plain(" "), arg(formatPath(path))]
	if (typeof args?.limit === "number") parts.push(note(` (limit ${args.limit})`))
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtGrep(args, options) {
	const formatPath = pathFormatter(options)
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	const parts = [
		title("grep"),
		plain(" "),
		pattern === null ? note("(missing pattern)") : arg(pattern),
		plain(" "),
		arg(formatPath(path)),
	]
	const glob = pickStr(args?.glob)
	if (glob) parts.push(note(` --glob ${glob}`))
	if (typeof args?.limit === "number") parts.push(note(` (limit ${args.limit})`))
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} options
 * @returns {ToolCallPart[]}
 */
function fmtFind(args, options) {
	const formatPath = pathFormatter(options)
	const pattern = pickStr(args?.pattern)
	const path = pickStr(args?.path) ?? "."
	const parts = [
		title("find"),
		plain(" "),
		pattern === null ? note("(missing pattern)") : arg(pattern),
		plain(" "),
		arg(formatPath(path)),
	]
	if (typeof args?.limit === "number") parts.push(note(` (limit ${args.limit})`))
	return parts
}

/**
 * @param {any} args
 * @param {ToolCallFormatOptions} _options
 * @returns {ToolCallPart[]}
 */
function fmtJs(args, _options) {
	const code = pickStr(args?.code)
	const display = code === null ? note("(missing code)") : code ? arg(oneLine(code).length > 100 ? `${oneLine(code).slice(0, 100)}…` : oneLine(code)) : note("...")
	return [title("js"), plain(" "), display]
}

/** @type {Record<string, (args: any, options: ToolCallFormatOptions) => ToolCallPart[]>} */
const REGISTRY = {
	read: fmtRead,
	write: fmtWrite,
	apply_patch: fmtApplyPatch,
	edit: fmtEdit,
	exec: fmtExec,
	exec_command: fmtExecCommand,
	write_stdin: fmtWriteStdin,
	bash: fmtBash,
	ls: fmtLs,
	grep: fmtGrep,
	find: fmtFind,
	js: fmtJs,
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
 * @param {string | undefined} name
 * @returns {string}
 */
export function normalizedToolName(name) {
	return (name || "tool").replace(/^functions\./, "")
}

/**
 * @param {string | undefined} name
 * @param {any} args
 * @param {ToolCallFormatOptions} [options]
 * @returns {{ parts: ToolCallPart[] }}
 */
export function formatToolCallParts(name, args, options = {}) {
	const normalizedName = normalizedToolName(name)
	const fmt = REGISTRY[normalizedName]
	if (fmt) return { parts: fmt(args, options) }
	const json = inlineJson(args)
	const parts = [title(normalizedName)]
	if (json) parts.push(plain(" "), note(json))
	return { parts }
}

/** @param {ToolCallPart[]} parts */
export function toolCallPartsText(parts) {
	return parts.map((part) => part.text).join("")
}
