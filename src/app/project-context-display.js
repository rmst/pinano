import { LAZY_NOTICE_HEADING } from "./lazy-context.js"
import { isProjectContextMessage, PROJECT_CONTEXT_HEADING } from "./project-context.js"

const CONTEXT_HEADINGS = [PROJECT_CONTEXT_HEADING, LAZY_NOTICE_HEADING]

/**
 * @param {any} message
 * @returns {string[]}
 */
function textBlocks(message) {
	const content = message?.content
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
	}
	if (typeof content === "string") return [content]
	return []
}

/**
 * Return the AGENTS.md / CLAUDE.md blocks that are part of the live model
 * context. New sessions expose one canonical injected context bundle; legacy
 * sessions may still contain startup messages or lazy tool-result notices.
 *
 * @param {ReadonlyArray<any>} messages
 * @returns {string[]}
 */
export function projectContextBlocks(messages = []) {
	/** @type {string[]} */
	const blocks = []
	for (const message of messages) {
		if (isProjectContextMessage(message)) {
			for (const text of textBlocks(message)) {
				const idx = text.indexOf(PROJECT_CONTEXT_HEADING)
				if (idx !== -1) blocks.push(text.slice(idx))
			}
			continue
		}
		if (message?.role !== "toolResult") continue
		for (const text of textBlocks(message)) {
			const idx = text.indexOf(LAZY_NOTICE_HEADING)
			if (idx !== -1) blocks.push(text.slice(idx))
		}
	}
	return blocks
}

/**
 * Extract absolute context-file paths from one context block. We only scan
 * text that follows one of Pinano's context headings, so ordinary markdown in
 * tool output or AGENTS.md content is not treated as a load announcement.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function projectContextPathsInText(text) {
	/** @type {string[]} */
	const paths = []
	for (const heading of CONTEXT_HEADINGS) {
		const idx = text.indexOf(heading)
		if (idx === -1) continue
		const after = text.slice(idx)
		const re = /^##\s+(\/.+?)\s*$/gm
		/** @type {RegExpExecArray | null} */
		let match
		while ((match = re.exec(after))) paths.push(match[1])
	}
	return paths
}

/**
 * @param {ReadonlyArray<any>} messages
 * @returns {string[]}
 */
export function projectContextPathsInMessages(messages = []) {
	return [...new Set(projectContextBlocks(messages).flatMap(projectContextPathsInText))]
}

/**
 * @param {object} input
 * @param {string} [input.systemPrompt]
 * @param {any[]} [input.tools]
 * @param {any[]} [input.messages]
 * @returns {string[]}
 */
export function formatSystemReport({ systemPrompt = "", tools = [], messages = [] } = {}) {
	const prompt = String(systemPrompt ?? "")
	const lines = ["--- system prompt"]
	if (prompt) lines.push(...prompt.split("\n"), `--- end system prompt (${prompt.length} chars)`)
	else lines.push("(empty)")

	lines.push("", `--- tools (${tools.length})`)
	for (const tool of tools) {
		lines.push(`## ${String(tool?.name ?? "?")}`)
		if (tool?.description) lines.push(`description: ${tool.description}`)
		const toolShape = tool?.kind === "custom" ? tool.format : tool?.parameters
		if (toolShape !== undefined) {
			lines.push(tool?.kind === "custom" ? "format:" : "parameters:")
			let json
			try {
				json = JSON.stringify(toolShape, null, 2)
			} catch {
				json = String(toolShape)
			}
			for (const line of json.split("\n")) lines.push(`  ${line}`)
		}
		lines.push("")
	}
	lines.push("--- end tools")

	const contextBlocks = projectContextBlocks(messages)
	lines.push("", `--- project context (${contextBlocks.length} block${contextBlocks.length === 1 ? "" : "s"})`)
	if (contextBlocks.length === 0) lines.push("(no AGENTS.md / CLAUDE.md loaded)")
	else {
		for (const block of contextBlocks) lines.push(...block.split("\n"), "")
	}
	lines.push("--- end project context")
	return lines
}
