// Component classes for transcript messages, ported (and slimmed) from
// pi-coding-agent's interactive components.
//
// Each class is a thin Container that renders one logical message into the
// chat transcript. Components mutate in place when the agent emits updates,
// so the streaming view shows partial content without re-creating widgets.
//
// Differences from upstream pi:
//   - Markdown structure is rendered, but syntax highlighting remains omitted.
//   - No image rendering, no kitty/iTerm2 image hand-off.
//   - No per-tool render widgets — tool-call args show as JSON, result bodies are hidden by default.
//   - No OSC 133 zone markers — those are nice for shell integration but
//     adding them inside our diff renderer hasn't been needed.

import { Box, Container, Markdown, Spacer, Text, TruncatedText } from "../../tui/index.js"
import { isResponsesCompactionBlock } from "../../responses-compaction.js"
import { getMarkdownTheme, theme } from "../theme.js"
import { formatToolCall } from "./tool-format.js"

/** @typedef {any} AnyMessage */
/**
 * @typedef {object} MessageRenderOptions
 * @property {boolean} [showThinkingOutput]
 * @property {boolean} [showToolOutput]
 */

/** @type {Required<MessageRenderOptions>} */
export const DEFAULT_MESSAGE_RENDER_OPTIONS = {
	showThinkingOutput: false,
	showToolOutput: false,
}

/**
 * @param {MessageRenderOptions | undefined} options
 * @returns {Required<MessageRenderOptions>}
 */
export function normalizeMessageRenderOptions(options) {
	return { ...DEFAULT_MESSAGE_RENDER_OPTIONS, ...(options ?? {}) }
}

/**
 * @param {any} block
 * @param {Required<MessageRenderOptions>} options
 */
function isVisibleAssistantBlock(block, options) {
	return (block.type === "text" && block.text?.trim())
		|| isResponsesCompactionBlock(block)
		|| (options.showThinkingOutput && block.type === "thinking" && block.thinking?.trim())
}

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
 * breathing room above and below the text inside the box.
 */
export class UserMessageComponent extends Container {
	/** @param {AnyMessage | string} message */
	constructor(message) {
		super()
		const text = typeof message === "string" ? message : userText(message)
		const box = new Box(1, 1, (s) => theme.bg("userMessageBg", s))
		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (s) => theme.fg("userMessageText", s),
			}),
		)
		this.addChild(box)
	}
}

// =============================================================================
// Assistant message
// =============================================================================

/**
 * Assistant message: text + optionally visible thinking blocks. Updated in-place as the agent
 * streams partial content. Tool-call blocks are NOT rendered here — the
 * agent loop creates a separate ToolExecutionComponent right after, so we
 * skip them to avoid duplicating the call.
 */
export class AssistantMessageComponent extends Container {
	/** @type {Container} */
	content
	/** @type {AnyMessage | undefined} */
	message
	/** @type {Required<MessageRenderOptions>} */
	options
	hasToolCalls = false

	/**
	 * @param {AnyMessage} [message]
	 * @param {MessageRenderOptions} [options]
	 */
	constructor(message, options) {
		super()
		this.options = normalizeMessageRenderOptions(options)
		this.content = new Container()
		this.addChild(this.content)
		if (message) this.update(message)
	}

	/** @param {AnyMessage} message */
	update(message) {
		this.message = message
		this.content.clear()

		// Compaction marker: render as a dim divider with metadata + the
		// summary text. Distinct visual treatment so the user can scan the
		// transcript and see where context was compacted, instead of the
		// marker looking like a regular model turn.
		if (message.compaction === true) {
			this.hasToolCalls = false
			this.renderCompactionMarker(message)
			return
		}

		const blocks = Array.isArray(message.content) ? message.content : []
		const hasToolCalls = blocks.some((/** @type {any} */ b) => b.type === "toolCall")
		this.hasToolCalls = hasToolCalls

		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i]
			if (b.type === "text" && b.text?.trim()) {
				this.content.addChild(
					new Markdown(b.text.trim(), 1, 0, getMarkdownTheme(), {
						color: (s) => theme.fg("text", s),
					}),
				)
			} else if (isResponsesCompactionBlock(b)) {
				this.content.addChild(new Text(theme.dim("─── earlier context compacted by provider ───"), 1, 0))
				const remaining = blocks.slice(i + 1)
				if (remaining.some((/** @type {any} */ c) => isVisibleAssistantBlock(c, this.options))) {
					this.content.addChild(new Spacer(1))
				}
			} else if (this.options.showThinkingOutput && b.type === "thinking" && b.thinking?.trim()) {
				const trimmed = b.thinking.trim()
				this.content.addChild(
					new Markdown(trimmed, 1, 0, getMarkdownTheme(), {
						color: (s) => theme.fg("thinkingText", s),
						italic: true,
					}),
				)
				const remaining = blocks.slice(i + 1)
				const moreVisible = remaining.some((/** @type {any} */ c) => isVisibleAssistantBlock(c, this.options))
				if (moreVisible) this.content.addChild(new Spacer(1))
			}
		}

		// Stop reasons. Aborts are intentional user/session state and are surfaced
		// by the surrounding UI; only real errors get an inline assistant note.
		// Tool-call assistants delegate error display to the tool component.
		if (!hasToolCalls && message.stopReason === "error") {
			if (this.content.children.length > 0) this.content.addChild(new Spacer(1))
			this.content.addChild(
				new Text(theme.fg("error", `Error: ${message.errorMessage ?? "Unknown error"}`), 1, 0),
			)
			this.content.addChild(new Text(theme.dim("press Esc Esc to rewind"), 1, 0))
		}
	}

	/** @param {AnyMessage} message */
	renderCompactionMarker(message) {
		const removed = message.removedCount ?? 0
		const kept = message.keptCount ?? 0
		const tokens = message.tokensBefore ?? 0
		// Build the metadata fragment only if the numbers exist (a marker
		// loaded from an older session may not have them).
		const meta = removed > 0
			? ` (${removed} message${removed === 1 ? "" : "s"} → ${kept} kept, ~${tokens} tok)`
			: ""
		this.content.addChild(new Text(theme.dim(`─── earlier context compacted${meta} ───`), 1, 0))
		const blocks = Array.isArray(message.content) ? message.content : []
		const body = blocks
			.filter((/** @type {any} */ b) => b.type === "text" && b.text?.trim())
			.map((/** @type {any} */ b) => b.text.replace(/^\[earlier context compacted\]\n?/, "").trim())
			.filter(Boolean)
			.join("\n")
		if (body) {
			this.content.addChild(
				new Markdown(body, 1, 0, getMarkdownTheme(), {
					color: (s) => theme.fg("dim", s),
				}),
			)
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

const TOOL_RESULT_MAX_LINES = 12
const TOOL_ERROR_INDENT = 1

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
 * Tool execution: pending box while the call is in-flight; flips to the
 * completed-call background once a result lands. Failures intentionally use
 * the same background so ordinary failed tool calls don't dominate the turn.
 *
 * Header line is rendered with a per-tool concise formatter (`read /etc/hosts`,
 * `$ npm test`, etc.) and truncated instead of wrapping, so ordinary tool-call
 * rows stay compact. Session metadata updates are wrapped across lines because
 * they often describe several changes. Unknown tools include a compact inline
 * JSON arg dump.
 *
 * Successful result bodies are hidden by default; when enabled, long results
 * get truncated to TOOL_RESULT_MAX_LINES. Errors stay visible so failures are
 * actionable without changing settings.
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
	/** @type {Required<MessageRenderOptions>} */
	options

	/**
	 * @param {string} toolName
	 * @param {any} args
	 * @param {MessageRenderOptions} [options]
	 */
	constructor(toolName, args, options) {
		super()
		this.options = normalizeMessageRenderOptions(options)
		this.toolName = toolName
		this.args = args
		this.box = new Box(1, 0, (s) => theme.bg("toolPendingBg", s))
		this.inner = new Container()
		this.box.addChild(this.inner)
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
		const { line } = formatToolCall(this.toolName, this.args, { state: this.state })
		const header = theme.fg("toolText", line)
		this.inner.addChild(this.toolName === "sessionWrite" ? new Text(header, 0, 0) : new TruncatedText(header, 0, 0))
		if (this.resultText !== null && (this.options.showToolOutput || this.state === "error")) {
			const trimmed = this.resultText.trim()
			const isError = this.state === "error"
			const paddingX = isError ? TOOL_ERROR_INDENT : 0
			if (trimmed) {
				if (!isError) this.inner.addChild(new Spacer(1))
				this.inner.addChild(new Text(theme.fg("toolOutput", truncateOutput(trimmed)), paddingX, 0))
			} else {
				this.inner.addChild(new Text(theme.fg("toolOutput", "(no output)"), paddingX, 0))
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
		this.addChild(new Text(labelText + theme.fg("customMessageText", text), 0, 0))
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
		this.addChild(new Text(theme.fg("text", text), 0, 0))
	}
}
