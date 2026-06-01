import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "./truncate.js"

const AsyncFunction = async function () {}.constructor

const DESC = `Evaluate one awaited JavaScript expression. Runs on Node >=22.6 or qn (a largely Node-compatible JavaScript runtime). The expression has standard JavaScript globals, dynamic import support, and a Pinano helper object named pinano. Use await pinano.help() or await pinano.help("session") to inspect available Pinano APIs. For multiple statements, wrap an async IIFE: (async () => { const values = [1, 2, 3]; return values.map((n) => n * 2) })().`

const jsSchema = {
	type: "object",
	properties: {
		code: {
			type: "string",
			description: "A single JavaScript expression to evaluate. The expression is awaited. Use an async IIFE for multiple statements.",
		},
	},
	required: ["code"],
	additionalProperties: false,
}

/** @param {string} code */
function normalizeExpression(code) {
	let trimmed = code.trim()
	while (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1).trimEnd()
	return trimmed
}

/** @param {string} code @param {string[]} bindingNames */
function compileExpression(code, bindingNames) {
	const expression = normalizeExpression(code)
	if (expression.length === 0) throw new Error("JS expression is empty")
	try {
		return new AsyncFunction(...bindingNames, `"use strict"\nreturn await (${expression}\n)`)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid JS expression: ${message}`)
	}
}

/** @param {unknown} value */
function valueType(value) {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	return typeof value
}

function jsonReplacer() {
	const seen = new WeakSet()
	return (_key, value) => {
		if (typeof value === "bigint") return `${value}n`
		if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`
		if (typeof value === "symbol") return value.toString()
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[Circular]"
			seen.add(value)
		}
		return value
	}
}

/** @param {unknown} value */
function serializeValue(value) {
	if (typeof value === "string") return value
	if (value === undefined) return "undefined"
	try {
		const json = JSON.stringify(value, jsonReplacer(), "\t")
		return json === undefined ? String(value) : json
	} catch {
		return String(value)
	}
}

/**
 * @param {unknown} value
 * @returns {import("../agent-core/types.js").AgentToolResult<any>}
 */
function resultFromValue(value) {
	const serialized = serializeValue(value)
	const truncation = truncateTail(serialized)
	let text = truncation.content
	if (truncation.truncated) {
		const reason = truncation.truncatedBy === "lines"
			? `showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)`
			: `${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`
		text += `${text ? "\n" : ""}[Truncated head: ${reason}]`
	}
	return {
		content: [{ type: "text", text }],
		details: {
			js: {
				returned: valueType(value),
				truncation,
			},
		},
	}
}

/** @param {Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>)} [bindings] */
async function resolveBindings(bindings) {
	if (!bindings) return {}
	return typeof bindings === "function" ? await bindings() : bindings
}

/**
 * @param {{ bindings?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>) }} [options]
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createJsTool(options = {}) {
	return {
		name: "js",
		label: "js",
		description: DESC,
		parameters: jsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { code }, signal) {
			if (signal?.aborted) throw new Error("Operation aborted")
			const bindings = await resolveBindings(options.bindings)
			const bindingNames = Object.keys(bindings)
			const fn = compileExpression(code, bindingNames)
			const value = await fn(...bindingNames.map((name) => bindings[name]))
			if (signal?.aborted) throw new Error("Operation aborted")
			return resultFromValue(value)
		},
	}
}
