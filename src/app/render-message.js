// Stringify an AgentMessage into a chunk of text to drop into the transcript.
// Pure formatting — no terminal capability checks, no TUI components.

import { theme } from "./theme.js"

/** @typedef {any} AnyMessage */

/**
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function indent(text, prefix) {
	return text
		.split("\n")
		.map((line) => prefix + line)
		.join("\n")
}

/**
 * @param {any} content
 * @returns {string}
 */
function flattenContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
}

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function renderUser(message) {
	const text = flattenContent(message.content).trim()
	return `${theme.cyan("> ")}${text}`
}

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function renderAssistant(message) {
	/** @type {string[]} */
	const blocks = []
	for (const block of message.content ?? []) {
		if (block.type === "thinking") {
			const t = block.thinking?.trim()
			if (t) blocks.push(theme.dim(`(thinking) ${t}`))
		} else if (block.type === "text") {
			if (block.text) blocks.push(block.text)
		} else if (block.type === "toolCall") {
			const args = JSON.stringify(block.arguments ?? {}, null, 0)
			blocks.push(theme.magenta(`→ ${block.name}(${args})`))
		}
	}
	let out = blocks.join("\n")
	if (message.errorMessage) {
		const tag = message.stopReason === "aborted" ? "aborted" : "error"
		out += (out ? "\n" : "") + theme.red(`[${tag}] ${message.errorMessage}`)
	}
	return out || theme.dim("(empty assistant turn)")
}

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function renderToolResult(message) {
	const tag = message.isError ? theme.red("[err]") : theme.green("[ok] ")
	const body = flattenContent(message.content) || "(no output)"
	return `${tag} ${theme.bold(message.toolName)}\n${indent(body, "  ")}`
}

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function renderCustom(message) {
	if (typeof message.content === "string") return theme.dim(`[${message.role}] ${message.content}`)
	return theme.dim(`[${message.role}]`)
}

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
export function renderMessage(message) {
	switch (message.role) {
		case "user":
			return renderUser(message)
		case "assistant":
			return renderAssistant(message)
		case "toolResult":
			return renderToolResult(message)
		default:
			return renderCustom(message)
	}
}
