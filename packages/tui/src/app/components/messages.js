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
//   - Tool calls use shared compact headers with expandable raw details; result bodies are hidden by default.
//   - No OSC 133 zone markers — those are nice for shell integration but
//     adding them inside our diff renderer hasn't been needed.

import { Box, Container, Markdown, RetainedComponent, Spacer, Text, TruncatedText, clickableRowSpan, truncateToWidth } from "../../tui/index.js"
import { isResponsesCompactionBlock } from "../../../../protocol/src/responses-compaction.js"
import { contextLoadDisplayFiles } from "../../../../server/src/session-manager/context-display.js"
import { getMarkdownTheme, theme } from "../theme.js"
import { compactionMarkerBody, compactionMarkerLabel } from "../../../../server/src/app/compaction/summary.js"
import { formatToolCall, formatToolPath } from "./tool-format.js"
import { isPromptImageMarkerText } from "../../../../protocol/src/prompt-images.js"
import { TRANSCRIPT_INDENT } from "./transcript.js"
import { BASH_SHORTCUT_MESSAGE_ROLE } from "../../../../server/src/session-manager/bash-shortcut-entry.js"
import { assistantInlineErrorTextForDisplay } from "../../../../protocol/src/transcript/message-display.js"
import { formatExpandedToolDetails } from "../../../../protocol/src/transcript/tool-details.js"

/** @typedef {any} AnyMessage */
/**
 * @typedef {object} MessageRenderOptions
 * @property {boolean} [showThinkingOutput]
 * @property {boolean} [showToolOutput]
 * @property {"all" | "progress" | "final"} [assistantTextMode]
 */
/**
 * @typedef {object} UserMessageOptions
 * @property {(message: AnyMessage | string, event: import("../../tui/tui.js").TuiMouseEvent) => any} [onContextMenu]
 */
/**
 * @typedef {object} AssistantMessageUpdateOptions
 * @property {boolean} [streaming]
 */

/** @type {Required<MessageRenderOptions>} */
export const DEFAULT_MESSAGE_RENDER_OPTIONS = {
	showThinkingOutput: false,
	showToolOutput: false,
	assistantTextMode: "all",
}

const ASSISTANT_FINAL_TEXT_INDENT = TRANSCRIPT_INDENT.primary
const ASSISTANT_SECONDARY_TEXT_INDENT = TRANSCRIPT_INDENT.secondary

/**
 * @param {MessageRenderOptions | undefined} options
 * @returns {Required<MessageRenderOptions>}
 */
export function normalizeMessageRenderOptions(options) {
	return { ...DEFAULT_MESSAGE_RENDER_OPTIONS, ...(options ?? {}) }
}

/**
 * @param {any} block
 * @param {AnyMessage} message
 * @param {boolean} hasToolCalls
 * @param {Required<MessageRenderOptions>} options
 * @param {boolean} [streaming]
 */
function isVisibleAssistantBlock(block, message, hasToolCalls, options, streaming = false) {
	if (block.type === "text" && block.text?.trim()) return assistantTextBlockSelected(message, block, hasToolCalls, options, streaming)
	if (isResponsesCompactionBlock(block)) return options.assistantTextMode === "all" || options.assistantTextMode === "final"
	return options.showThinkingOutput
		&& (options.assistantTextMode === "all" || options.assistantTextMode === "progress")
		&& block.type === "thinking"
		&& block.thinking?.trim()
}

/** @param {any} block @returns {"commentary" | "final_answer" | undefined} */
function assistantTextPhase(block) {
	if (block?.phase === "commentary" || block?.phase === "final_answer") return block.phase
	const signature = block?.textSignature
	if (typeof signature !== "string" || !signature.startsWith("{")) return undefined
	try {
		const parsed = JSON.parse(signature)
		if (parsed?.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) return parsed.phase
	} catch {}
	return undefined
}

/**
 * @param {AnyMessage} message
 * @param {any} block
 * @param {boolean} hasToolCalls
 * @param {boolean} [streaming]
 */
function isAssistantProgressText(message, block, hasToolCalls, streaming = false) {
	const phase = assistantTextPhase(block)
	if (phase === "commentary") return true
	if (phase === "final_answer") return false
	if (streaming) return true
	return message.stopReason === "toolUse" || hasToolCalls
}

/**
 * @param {AnyMessage} message
 * @param {any} block
 * @param {boolean} hasToolCalls
 * @param {Required<MessageRenderOptions>} options
 * @param {boolean} [streaming]
 */
function assistantTextBlockSelected(message, block, hasToolCalls, options, streaming = false) {
	const progress = isAssistantProgressText(message, block, hasToolCalls, streaming)
	if (options.assistantTextMode === "progress") return progress
	if (options.assistantTextMode === "final") return !progress
	return true
}

// =============================================================================
// User message
// =============================================================================

/**
 * @param {AnyMessage} message
 * @returns {string}
 */
function visibleMessageText(message) {
	const c = message.content
	if (typeof c === "string") return c
	if (!Array.isArray(c)) return ""
	return c
		.filter((/** @type {any} */ p) => p.type === "text")
		.filter((/** @type {any} */ p) => !isPromptImageMarkerText(p.text ?? ""))
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
	/** @type {AnyMessage | string} */
	message
	/** @type {((message: AnyMessage | string, event: import("../../tui/tui.js").TuiMouseEvent) => any) | undefined} */
	onContextMenu

	/** @param {AnyMessage | string} message @param {UserMessageOptions} [options] */
	constructor(message, options = {}) {
		super()
		this.message = message
		this.onContextMenu = options.onContextMenu
		const text = typeof message === "string" ? message : visibleMessageText(message)
		const box = new Box(1, 1, (s) => theme.bg("userMessageBg", s))
		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (s) => theme.fg("userMessageText", s),
			}),
		)
		this.addChild(box)
	}

	/** @param {import("../../tui/tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		if (event.type !== "contextmenu" || typeof this.onContextMenu !== "function") return { consume: false }
		const result = this.onContextMenu(this.message, event)
		if (result?.consume === false) return result
		event.stopPropagation()
		return result ?? { consume: true }
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
	streaming = false

	/**
	 * @param {AnyMessage} [message]
	 * @param {MessageRenderOptions} [options]
	 * @param {AssistantMessageUpdateOptions} [updateOptions]
	 */
	constructor(message, options, updateOptions) {
		super()
		this.options = normalizeMessageRenderOptions(options)
		this.content = new Container()
		this.addChild(this.content)
		if (message) this.update(message, updateOptions)
	}

	/**
	 * @param {AnyMessage} message
	 * @param {AssistantMessageUpdateOptions} [updateOptions]
	 */
	update(message, updateOptions = {}) {
		this.message = message
		this.streaming = updateOptions.streaming === true
		this.content.clear()

		// Compaction marker: render as a dim divider with metadata + the
		// summary text. It is collapsed by default because the full handoff is
		// model-facing/debug information, but the boundary remains inspectable.
		if (message.compaction === true) {
			this.hasToolCalls = false
			this.renderCompactionMarker(message)
			return
		}

		const blocks = Array.isArray(message.content) ? message.content : []
		const hasToolCalls = blocks.some((/** @type {any} */ b) => b.type === "toolCall")
		this.hasToolCalls = hasToolCalls
		/** @type {boolean | undefined} */
		let previousTextProgress

		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i]
			if (b.type === "text" && b.text?.trim()) {
				const progress = isAssistantProgressText(message, b, hasToolCalls, this.streaming)
				if (!assistantTextBlockSelected(message, b, hasToolCalls, this.options, this.streaming)) continue
				if (previousTextProgress !== undefined && previousTextProgress !== progress) {
					this.content.addChild(new Spacer(1))
				}
				this.content.addChild(
					new Markdown(b.text.trim(), progress ? ASSISTANT_SECONDARY_TEXT_INDENT : ASSISTANT_FINAL_TEXT_INDENT, 0, getMarkdownTheme(), {
						color: (s) => theme.fg(progress ? "assistantProgressText" : "text", s),
					}),
				)
				previousTextProgress = progress
			} else if (isResponsesCompactionBlock(b) && this.options.assistantTextMode !== "progress") {
				this.content.addChild(new Text(theme.dim("─── earlier context compacted by provider ───"), ASSISTANT_SECONDARY_TEXT_INDENT, 0))
				previousTextProgress = undefined
				const remaining = blocks.slice(i + 1)
				if (remaining.some((/** @type {any} */ c) => isVisibleAssistantBlock(c, message, hasToolCalls, this.options, this.streaming))) {
					this.content.addChild(new Spacer(1))
				}
			} else if (
				this.options.showThinkingOutput
				&& (this.options.assistantTextMode === "all" || this.options.assistantTextMode === "progress")
				&& b.type === "thinking"
				&& b.thinking?.trim()
			) {
				const trimmed = b.thinking.trim()
				this.content.addChild(
					new Markdown(trimmed, ASSISTANT_SECONDARY_TEXT_INDENT, 0, getMarkdownTheme(), {
						color: (s) => theme.fg("thinkingText", s),
						italic: true,
					}),
				)
				previousTextProgress = undefined
				const remaining = blocks.slice(i + 1)
				const moreVisible = remaining.some((/** @type {any} */ c) => isVisibleAssistantBlock(c, message, hasToolCalls, this.options, this.streaming))
				if (moreVisible) this.content.addChild(new Spacer(1))
			}
		}

		// Stop reasons. Aborts are intentional user/session state and are surfaced
		// by the surrounding UI; only real errors get an inline assistant note.
		// Tool-call assistants delegate error display to the tool component.
		const inlineError = this.options.assistantTextMode === "progress" ? undefined : assistantInlineErrorTextForDisplay(message, hasToolCalls)
		if (inlineError) {
			if (this.content.children.length > 0) this.content.addChild(new Spacer(1))
			this.content.addChild(new Text(theme.fg("error", inlineError), ASSISTANT_SECONDARY_TEXT_INDENT, 0))
			this.content.addChild(new Text(theme.dim("press Esc Esc to rewind"), ASSISTANT_SECONDARY_TEXT_INDENT, 0))
		}
	}

	/** @param {AnyMessage} message */
	renderCompactionMarker(message) {
		this.content.addChild(new CompactionMarkerComponent(message))
	}

	/** @returns {boolean} */
	hasContent() {
		return this.content.children.length > 0
	}
}

class TranscriptDisclosureToggleLine extends RetainedComponent {
	/** @type {TranscriptDisclosureComponent} */
	owner
	/** @type {string} */
	text = ""

	/** @param {TranscriptDisclosureComponent} owner */
	constructor(owner) {
		super()
		this.owner = owner
		this.updateText()
	}

	updateText() {
		const marker = this.owner.expanded ? "▾" : "▸"
		this.text = `${" ".repeat(ASSISTANT_SECONDARY_TEXT_INDENT)}${theme.dim(`${marker} ${this.owner.label}`)}`
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[], sourceSpans: import("../../tui/render-frame.js").RenderSourceSpan[], regions: import("../../tui/render-frame.js").RenderRegion[] }}
	 */
	renderFrame(width) {
		this.updateText()
		const span = clickableRowSpan({
			line: 0,
			text: this.text,
			width,
			component: this,
			id: this.owner.id,
			role: "button",
			label: `${this.owner.expanded ? "collapse" : "expand"} ${this.owner.disclosureName}`,
			onClick: () => this.owner.toggleExpanded(),
		})
		return { lines: [this.text], spans: span ? [span] : [], sourceSpans: [], regions: [] }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
}

class TranscriptDisclosureComponent extends Container {
	/** @type {string} */
	label
	/** @type {string} */
	body
	/** @type {string} */
	id
	/** @type {string} */
	disclosureName
	expanded = false

	/** @param {{ label: string, body: string, id: string, disclosureName: string }} options */
	constructor(options) {
		super()
		this.label = options.label
		this.body = options.body
		this.id = options.id
		this.disclosureName = options.disclosureName
		this.rebuild()
	}

	rebuild() {
		this.clear()
		const toggle = new TranscriptDisclosureToggleLine(this)
		if (!this.expanded) {
			this.addChild(toggle)
			return
		}
		const box = new Box(0, 0, (s) => theme.bg("toolSuccessBg", s))
		const inner = new Container()
		box.addChild(inner)
		inner.addChild(toggle)
		if (this.body) inner.addChild(new Text(theme.fg("toolOutput", this.body), 1, 0))
		this.addChild(box)
	}

	toggleExpanded() {
		this.expanded = !this.expanded
		this.rebuild()
		return { consume: true }
	}
}

class CompactionMarkerComponent extends TranscriptDisclosureComponent {
	/** @param {AnyMessage} message */
	constructor(message) {
		super({
			label: compactionMarkerLabel(message),
			body: compactionMarkerBody(message),
			id: `compaction:${message?.entryId ?? message?.timestamp ?? "marker"}`,
			disclosureName: "compaction summary",
		})
	}
}

// =============================================================================
// Tool execution
// =============================================================================

const TOOL_RESULT_MAX_LINES = 12
const TOOL_ERROR_INDENT = 1
const TOOL_DETAIL_INDENT = 1

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

class ToolExecutionHeaderLine extends RetainedComponent {
	/** @type {ToolExecutionComponent} */
	owner
	/** @type {string} */
	text = ""

	/** @param {ToolExecutionComponent} owner */
	constructor(owner) {
		super()
		this.owner = owner
		this.updateText()
	}

	updateText() {
		const marker = this.owner.expanded ? "▾" : "▸"
		const { line } = formatToolCall(this.owner.toolName, this.owner.args, { state: this.owner.state })
		this.text = `${theme.dim(marker)} ${theme.fg("toolText", line)}`
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[], sourceSpans: import("../../tui/render-frame.js").RenderSourceSpan[], regions: import("../../tui/render-frame.js").RenderRegion[] }}
	 */
	renderFrame(width) {
		this.updateText()
		const rendered = truncateToWidth(this.text, Math.max(1, width), "", false)
		const span = clickableRowSpan({
			line: 0,
			text: rendered,
			width,
			component: this,
			id: `tool:${this.owner.toolCallId ?? this.owner.toolName}`,
			role: "button",
			label: this.owner.expanded ? "collapse tool details" : "expand tool details",
			onClick: () => this.owner.toggleExpanded(),
		})
		return { lines: [rendered], spans: span ? [span] : [], sourceSpans: [], regions: [] }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
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
	/** @type {string | undefined} */
	toolCallId
	/** @type {any} */
	args
	/** @type {string | null} */
	resultText = null
	/** @type {any} */
	result = null
	/** @type {Required<MessageRenderOptions>} */
	options
	expanded = false

	/**
	 * @param {string} toolName
	 * @param {any} args
	 * @param {MessageRenderOptions} [options]
	 * @param {{ toolCallId?: string }} [metadata]
	 */
	constructor(toolName, args, options, metadata = {}) {
		super()
		this.options = normalizeMessageRenderOptions(options)
		this.toolName = toolName
		this.toolCallId = metadata.toolCallId
		this.args = args
		this.box = new Box(0, 0, (s) => theme.bg("toolPendingBg", s))
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
	 * @param {any} [result]
	 */
	setResult(text, isError, result = undefined) {
		this.resultText = text
		this.result = result ?? { content: [{ type: "text", text }] }
		this.state = isError ? "error" : "success"
		const tok = isError ? "toolErrorBg" : "toolSuccessBg"
		this.box.setBgFn((s) => theme.bg(tok, s))
		this.rebuild()
	}

	toggleExpanded() {
		this.expanded = !this.expanded
		this.rebuild()
		return { consume: true }
	}

	rebuild() {
		this.inner.clear()
		this.inner.addChild(new ToolExecutionHeaderLine(this))
		if (this.expanded) {
			const details = formatExpandedToolDetails({
				name: this.toolName,
				id: this.toolCallId,
				args: this.args,
				result: this.result,
				isError: this.state === "error",
			})
			this.inner.addChild(new Text(theme.fg("toolOutput", details), TOOL_DETAIL_INDENT, 0))
		} else if (this.resultText !== null && (this.options.showToolOutput || this.state === "error")) {
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
// Bash shortcut
// =============================================================================

/** @param {AnyMessage} message */
function bashShortcutData(message) {
	const shortcut = message?.bashShortcut ?? {}
	return {
		command: typeof shortcut.command === "string" ? shortcut.command : "",
		output: typeof shortcut.output === "string" ? shortcut.output : "",
		exitCode: typeof shortcut.exitCode === "number" ? shortcut.exitCode : undefined,
		excludeFromContext: shortcut.excludeFromContext === true,
	}
}

export class BashShortcutComponent extends Container {
	/** @param {AnyMessage} message */
	constructor(message) {
		super()
		const shortcut = bashShortcutData(message)
		const state = typeof shortcut.exitCode === "number" && shortcut.exitCode !== 0 ? "error" : "success"
		const box = new Box(0, 0, (s) => theme.bg(state === "error" ? "toolErrorBg" : "toolSuccessBg", s))
		const inner = new Container()
		box.addChild(inner)
		this.addChild(box)

		const { line } = formatToolCall("bash", { command: shortcut.command }, { state })
		const noContext = shortcut.excludeFromContext ? theme.fg("toolText", " (no-ctx)") : ""
		inner.addChild(new TruncatedText(line + noContext, 0, 0))
		const output = shortcut.output.trim()
		if (output) inner.addChild(new Text(theme.fg("toolOutput", truncateOutput(output)), 1, 0))
	}
}

/** @param {AnyMessage} message */
export function isBashShortcutMessage(message) {
	return message?.role === BASH_SHORTCUT_MESSAGE_ROLE
}

// =============================================================================
// Context / custom / system messages
// =============================================================================

/** Compact project-location marker whose expanded body is the model-facing notice recorded for that move. */
export class ProjectLocationComponent extends TranscriptDisclosureComponent {
	/** @param {AnyMessage} message */
	constructor(message) {
		const root = message?.projectLocationChanged?.root
		super({
			label: root ? `project dir changed to ${formatToolPath(root)}` : "project dir changed",
			body: visibleMessageText(message),
			id: `project-location:${message?.entryId ?? message?.timestamp ?? "marker"}`,
			disclosureName: "project location update",
		})
	}
}

/**
 * @param {any} load
 * @returns {string[]}
 */
function contextLoadPaths(load) {
	return contextLoadDisplayFiles(load)
		.map((/** @type {any} */ file) => file?.path)
		.filter((/** @type {any} */ path) => typeof path === "string" && path.length > 0)
}

/**
 * @returns {string}
 */
function contextLabel() {
	return theme.bold(theme.fg("customMessageLabel", "context"))
}

/**
 * @param {string} path
 * @returns {string}
 */
function contextLoadPathLine(path) {
	return `${contextLabel()} ${theme.fg("toolText", "loaded")} ${theme.fg("toolArg", formatToolPath(path))}`
}

/**
 * Compact context-load marker. It borrows the single-line tool-call rhythm, but without a background block.
 */
export class ContextLoadComponent extends Container {
	/**
	 * @param {any} load
	 * @param {string} [fallbackText]
	 */
	constructor(load, fallbackText = "") {
		super()
		const paths = contextLoadPaths(load)
		const lines = paths.length > 0
			? paths.map(contextLoadPathLine)
			: String(fallbackText ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => `${contextLabel()} ${theme.fg("customMessageText", line)}`)
		for (const line of lines) this.addChild(new TruncatedText(line, 0, 0))
	}
}

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
