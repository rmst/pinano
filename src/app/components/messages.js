// Component classes for chat-mode messages, ported (and slimmed) from
// pi-coding-agent's interactive components.
//
// Each class is a thin Container that renders one logical message into the
// chat transcript. Components mutate in place when the agent emits updates,
// so the streaming view shows partial content without re-creating widgets.
//
// Differences from upstream pi:
//   - No Markdown rendering — we use Text with raw text. Pinano deliberately
//     drops markdown/syntax highlighting (see COMPARISON.md).
//   - No image rendering, no kitty/iTerm2 image hand-off.
//   - No per-tool render widgets — tool-call args show as JSON, results as text.
//   - No OSC 133 zone markers — those are nice for shell integration but
//     adding them inside our diff renderer hasn't been needed.

import { Box, Container, Spacer, Text } from "../../tui/index.js"
import { theme } from "../theme.js"
import { formatToolCall } from "./tool-format.js"

/** @typedef {any} AnyMessage */

// =============================================================================
// User message
// =============================================================================

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function userText(message) {
	const c = message.content
	if (typeof c === "string") return c
	if (!Array.isArray(c)) return ""
	return c
		.filter((/** @type {any} */ p) => p.type === "text")
		.map((/** @type {any} */ p) => p.text)
		.join("")
		.trim()
}

/**
 * User message: a colored box containing the prompt text. The bg helps the
 * user-supplied content stand apart from the assistant's output even when
 * the transcript is long. Same paddingX=1, paddingY=1 as pi so the box has
 * breathing room above and below the text.
 */
export class UserMessageComponent extends Container {
	/** @param {AnyMessage | string} message */
	constructor(message) {
		super()
		const text = typeof message === "string" ? message : userText(message)
		// Spacer above so adjacent user messages don't visually fuse together.
		this.addChild(new Spacer(1))
		const box = new Box(1, 1, (s) => theme.bg("userMessageBg", s))
		box.addChild(new Text(theme.fg("userMessageText", text), 0, 0))
		this.addChild(box)
	}
}

// =============================================================================
// Assistant message
// =============================================================================

/**
 * Assistant message: text + thinking blocks. Updated in-place as the agent
 * streams partial content. Tool-call blocks are NOT rendered here — the
 * agent loop creates a separate ToolExecutionComponent right after, so we
 * skip them to avoid duplicating the call.
 */
export class AssistantMessageComponent extends Container {
	/** @type {Container} */
	content
	/** @type {AnyMessage | undefined} */
	message
	hasToolCalls = false

	/** @param {AnyMessage} [message] */
	constructor(message) {
		super()
		this.content = new Container()
		this.addChild(this.content)
		if (message) this.update(message)
	}

	/** @param {AnyMessage} message */
	update(message) {
		this.message = message
		this.content.clear()

		const blocks = Array.isArray(message.content) ? message.content : []
		const visible = blocks.filter(
			(/** @type {any} */ b) =>
				(b.type === "text" && b.text?.trim()) ||
				(b.type === "thinking" && b.thinking?.trim()),
		)
		const hasToolCalls = blocks.some((/** @type {any} */ b) => b.type === "toolCall")
		this.hasToolCalls = hasToolCalls

		if (visible.length > 0) this.content.addChild(new Spacer(1))

		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i]
			if (b.type === "text" && b.text?.trim()) {
				this.content.addChild(new Text(b.text.trim(), 1, 0))
			} else if (b.type === "thinking" && b.thinking?.trim()) {
				const trimmed = b.thinking.trim()
				const colored = theme.italic(theme.fg("thinkingText", trimmed))
				this.content.addChild(new Text(colored, 1, 0))
				const remaining = blocks.slice(i + 1)
				const moreVisible = remaining.some(
					(/** @type {any} */ c) =>
						(c.type === "text" && c.text?.trim()) ||
						(c.type === "thinking" && c.thinking?.trim()),
				)
				if (moreVisible) this.content.addChild(new Spacer(1))
			}
		}

		// Stop reasons. We hide error/abort messaging when there are tool calls
		// because the tool component already shows the failure state.
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const msg =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted"
				this.content.addChild(new Spacer(1))
				this.content.addChild(new Text(theme.fg("error", msg), 1, 0))
			} else if (message.stopReason === "error") {
				this.content.addChild(new Spacer(1))
				this.content.addChild(
					new Text(theme.fg("error", `Error: ${message.errorMessage ?? "Unknown error"}`), 1, 0),
				)
			}
		}
	}

	/** @returns {boolean} */
	hasContent() {
		return this.content.children.length > 0
	}
}

// =============================================================================
// Tool execution
// =============================================================================

/**
 * @param {any} args
 * @returns {string}
 */
function formatArgsJson(args) {
	if (args === undefined || args === null) return ""
	try {
		const json = JSON.stringify(args, null, 2)
		// JSON.stringify({}) → "{}"; collapse to nothing for the empty case.
		return json === "{}" ? "" : json
	} catch {
		return String(args)
	}
}

const TOOL_RESULT_MAX_LINES = 12

/**
 * @param {string} text
 * @returns {string}
 */
function truncateOutput(text) {
	const lines = text.split("\n")
	if (lines.length <= TOOL_RESULT_MAX_LINES) return text
	const head = lines.slice(0, TOOL_RESULT_MAX_LINES)
	const hidden = lines.length - TOOL_RESULT_MAX_LINES
	return [...head, `… +${hidden} more line${hidden === 1 ? "" : "s"}`].join("\n")
}

/**
 * Tool execution: pending box (gray bg) while the call is in-flight; flips
 * to a green-ish "success" or red-ish "error" bg once a result lands.
 *
 * Header line is rendered with a per-tool concise formatter (`read /etc/hosts`,
 * `$ npm test`, etc.) — same look as pi. Unknown tools fall back to a JSON
 * arg dump like pi's `formatToolExecution`.
 *
 * Long results get truncated to TOOL_RESULT_MAX_LINES — pi has expandable
 * results behind a hotkey; we just clip statically. Removes the "tool result
 * spans 50 rows and pushes the editor off-screen" footgun.
 */
export class ToolExecutionComponent extends Container {
	/** @type {Box} */
	box
	/** @type {Container} */
	inner
	/** @type {"pending" | "success" | "error"} */
	state = "pending"
	/** @type {string} */
	toolName
	/** @type {any} */
	args
	/** @type {string | null} */
	resultText = null

	/**
	 * @param {string} toolName
	 * @param {any} args
	 */
	constructor(toolName, args) {
		super()
		this.toolName = toolName
		this.args = args
		this.box = new Box(1, 0, (s) => theme.bg("toolPendingBg", s))
		this.inner = new Container()
		this.box.addChild(this.inner)
		this.addChild(new Spacer(1))
		this.addChild(this.box)
		this.rebuild()
	}

	/** @param {any} args */
	updateArgs(args) {
		this.args = args
		this.rebuild()
	}

	/**
	 * @param {string} text
	 * @param {boolean} isError
	 */
	setResult(text, isError) {
		this.resultText = text
		this.state = isError ? "error" : "success"
		const tok = isError ? "toolErrorBg" : "toolSuccessBg"
		this.box.setBgFn((s) => theme.bg(tok, s))
		this.rebuild()
	}

	rebuild() {
		this.inner.clear()
		const { line, jsonFallback } = formatToolCall(this.toolName, this.args)
		this.inner.addChild(new Text(line, 0, 0))
		if (jsonFallback) {
			const json = formatArgsJson(this.args)
			if (json) this.inner.addChild(new Text(theme.fg("toolOutput", json), 0, 0))
		}
		if (this.resultText !== null) {
			const trimmed = this.resultText.trim()
			if (trimmed) {
				this.inner.addChild(new Spacer(1))
				this.inner.addChild(new Text(theme.fg("toolOutput", truncateOutput(trimmed)), 0, 0))
			} else {
				this.inner.addChild(new Text(theme.fg("toolOutput", "(no output)"), 0, 0))
			}
		}
	}

	/** @returns {"pending" | "success" | "error"} */
	getState() {
		return this.state
	}
}

// =============================================================================
// Custom / system messages
// =============================================================================

/**
 * Used for synthetic messages we inject into the transcript: status notes,
 * info banners, errors. They render with a subtle accent label so users can
 * distinguish them from real user/assistant turns.
 */
export class CustomMessageComponent extends Container {
	/**
	 * @param {string} text
	 * @param {{ label?: string, tone?: "info" | "warn" | "error" }} [opts]
	 */
	constructor(text, opts = {}) {
		super()
		const tone = opts.tone ?? "info"
		const labelColor =
			tone === "error" ? "error" : tone === "warn" ? "warning" : "customMessageLabel"
		const labelText = opts.label
			? theme.bold(theme.fg(labelColor, `[${opts.label}]`)) + " "
			: ""
		this.addChild(new Text(labelText + text, 0, 0))
	}
}

/**
 * Plain text line — a thin shim we use during session replay where the
 * incoming string is already styled.
 */
export class TextLine extends Container {
	/** @param {string} text */
	constructor(text) {
		super()
		this.addChild(new Text(text, 0, 0))
	}
}
