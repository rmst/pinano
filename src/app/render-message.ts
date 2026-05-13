// Stringify an AgentMessage into a chunk of text to drop into the transcript.
// Pure formatting — no terminal capability checks, no TUI components.

import { theme } from "./theme.ts"

type AnyMessage = any

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => prefix + line)
		.join("\n")
}

function flattenContent(content: any): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
}

function renderUser(message: AnyMessage): string {
	const text = flattenContent(message.content).trim()
	return `${theme.cyan("> ")}${text}`
}

function renderAssistant(message: AnyMessage): string {
	const blocks: string[] = []
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

function renderToolResult(message: AnyMessage): string {
	const tag = message.isError ? theme.red("[err]") : theme.green("[ok] ")
	const body = flattenContent(message.content) || "(no output)"
	return `${tag} ${theme.bold(message.toolName)}\n${indent(body, "  ")}`
}

function renderCustom(message: AnyMessage): string {
	if (typeof message.content === "string") return theme.dim(`[${message.role}] ${message.content}`)
	return theme.dim(`[${message.role}]`)
}

export function renderMessage(message: AnyMessage): string {
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
