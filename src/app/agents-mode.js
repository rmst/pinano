// Service-backed agent view TUI: one screen for dispatching, monitoring,
// peeking, and opening Pinano sessions.

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { resolve } from "node:path"

import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Input,
	Loader,
	ProcessTerminal,
	RetainedComponent,
	Spacer,
	TUI,
	Text,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	clipLinesToViewport,
	hyperlink,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../tui/index.js"
import {
	AssistantMessageComponent,
	ContextLoadComponent,
	CustomMessageComponent,
	TextLine,
	ToolExecutionComponent,
	UserMessageComponent,
} from "./components/messages.js"
import { TranscriptContainer } from "./components/transcript.js"
import { REASONING_LEVELS, reasoningLevelLabel } from "../reasoning.js"
import { Footer, modelDisplayLabel } from "./components/footer.js"
import { pickInline } from "./components/inline-picker.js"
import { pickFromOverlay } from "./components/picker.js"
import { pickModel, rowsForModels } from "./components/model-selector.js"
import { showTextModal } from "./components/text-modal.js"
import { promptForInput } from "./components/prompt-input.js"
import { pickHistoryTarget } from "./components/history-selector.js"
import { API_KEY_PROVIDER_INFOS, deleteCredential, detectedEnvApiKeys, getCredential, hasConfiguredProviderCredentials, listProviders, setCredential } from "./auth.js"
import { loginCodex } from "../ai-apis/codex/index.js"
import { availableModelEntries, findModelEntry, modelRef, modelRefMatches } from "./models.js"
import { loadSettings, messageRenderOptionsFromSettings, updateSetting } from "./settings.js"
import { authFilePath } from "./paths.js"
import { parseBashShortcut } from "./bash-shortcut.js"
import { readClipboardImage } from "./clipboard-image.js"
import { promptImageLabel, promptImagePlaceholders } from "../prompt-images.js"
import {
	codexUsageBaseUrlForModel,
	codexUsageBaseUrlFromSettings,
	codexUsageStatusTone,
	codexUsageThresholdMessages,
	fetchCodexUsage,
	formatCodexUsage,
	formatCodexUsageInlineSummary,
	formatCodexUsageLowStatus,
} from "./codex-usage.js"
import { isFastModeEligibleModel } from "./fast-mode.js"
import { formatContextReport } from "./context-report.js"
import { formatSystemReport, projectContextPathsInMessages } from "./project-context-display.js"
import { editorTheme, theme } from "./theme.js"
import { isProjectContextMessage } from "./project-context.js"
import { applySessionEvent, cloneSessionSnapshot, eventInvalidatesSessionList, eventInvalidatesSessionSnapshot, messageKey } from "./session-state.js"
import { overviewRoute, routeToArg, routeToCliArgs, sessionRoute, settingsCredentialsRoute } from "./routes.js"
import { reexecRuntime } from "./reexec-runtime.js"


/** @typedef {import("./stderr-capture.js").StderrCapture} StderrCapture */
/** @typedef {import("./routes.js").PinanoRoute} PinanoRoute */

/** @param {string} text */
function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/**
 * @param {string} text
 * @param {number} width
 */
function padToWidth(text, width) {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)))
}

/**
 * @param {string} text
 * @param {number} width
 */
function fit(text, width) {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width)
}

/** @param {string} text @param {"normal" | "warn" | "error"} [tone] */
function colorUsageStatus(text, tone = "normal") {
	if (tone === "error") return theme.red(text)
	if (tone === "warn") return theme.yellow(text)
	return theme.dim(text)
}

/** @param {unknown} value */
function singleLine(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
}

/** @param {string} p */
function compactHomePath(p) {
	const home = resolve(homedir())
	const path = resolve(p)
	if (path === home) return "~"
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
	return path
}

function promptAttachmentsForText(promptImages, text) {
	const byPlaceholder = new Map(promptImages.map((attachment) => [attachment.placeholder, attachment]))
	const seen = new Set()
	return promptImagePlaceholders(text).flatMap((item) => {
		if (seen.has(item.placeholder)) return []
		const attachment = byPlaceholder.get(item.placeholder)
		if (!attachment) return []
		seen.add(item.placeholder)
		return [attachment]
	})
}

function clearPromptImageAttachmentsForText(promptImages, text) {
	return promptImages.filter((attachment) => !text.includes(attachment.placeholder))
}

function insertPromptImageAttachment(editor, promptImages, promptImageCounter, image) {
	const placeholder = promptImageLabel(promptImageCounter + 1)
	promptImages.push({ placeholder, image })
	const current = editor.getText()
	const prefix = current && !/\s$/.test(current) ? " " : ""
	editor.insertTextAtCursor(`${prefix}${placeholder}`)
	return promptImageCounter + 1
}

/** @param {string} text @param {number} width */
function truncateLeftToWidth(text, width) {
	if (visibleWidth(text) <= width) return text
	const ellipsis = "..."
	if (width <= visibleWidth(ellipsis)) return truncateToWidth(ellipsis, width, "")
	const target = width - visibleWidth(ellipsis)
	let suffix = ""
	for (const char of Array.from(text).reverse()) {
		const candidate = `${char}${suffix}`
		if (visibleWidth(candidate) > target) break
		suffix = candidate
	}
	return `${ellipsis}${suffix}`
}

/** @param {string} left @param {string} right @param {number} width */
function leftRightLine(left, right, width) {
	if (!right) return fit(left, width)
	const minGap = 2
	const rightWidth = width - visibleWidth(left) - minGap
	if (rightWidth <= 0) return fit(left, width)
	const clippedRight = truncateLeftToWidth(right, rightWidth)
	const coloredRight = theme.dim(clippedRight)
	const gap = " ".repeat(Math.max(minGap, width - visibleWidth(left) - visibleWidth(coloredRight)))
	return `${left}${gap}${coloredRight}`
}

/** @param {Array<[string, string]>} hints @param {number} width */
function renderKeyHints(hints, width) {
	const line = hints
		.map(([key, label]) => `${theme.cyan(key)} ${theme.dim(label)}`)
		.join(theme.dim(" · "))
	return [fit(line, width)]
}

/** @param {import("./settings.js").Settings | undefined} settings */
export function overviewModelLabel(settings) {
	const model = settings?.model
	if (!model) return ""
	const entry = findModelEntry(model, { models: settings.models })
	const provider = entry?.provider ?? (model.startsWith("openai-codex/") ? "openai-codex" : undefined)
	return modelDisplayLabel({ id: entry?.id ?? model, provider }, entry)
}

/** @param {import("./settings.js").Settings | undefined} settings */
export function overviewModelStatusText(settings) {
	const label = overviewModelLabel(settings)
	if (!label) return ""
	return `${label} │ reasoning=${reasoningLevelLabel(settings?.thinkingLevel)}`
}

/** @param {import("./settings.js").Settings | undefined} settings */
function overviewModelStatusLine(settings, usageStatus) {
	const label = overviewModelLabel(settings)
	if (!label) return ""
	const base = [theme.cyan(label), theme.dim(`reasoning=${reasoningLevelLabel(settings?.thinkingLevel)}`)].join(theme.dim(" │ "))
	return usageStatus?.text
		? `${base}${theme.dim(" | ")}${colorUsageStatus(usageStatus.text, usageStatus.tone)}`
		: base
}

/** @param {unknown} err */
function isConnectionReset(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const text = `${cur?.message ?? cur}`
		if (text.includes("ECONNRESET") || text.includes("connection reset by peer")) return true
		cur = cur.cause
	}
	return false
}

/** @param {unknown} err */
function isStaleRuntimeError(err) {
	let cur = /** @type {any} */ (err)
	while (cur) {
		const text = `${cur?.message ?? cur}`
		if (/\bpinano client is stale\b/i.test(text)) return true
		cur = cur.cause
	}
	return false
}

const DOUBLE_ESCAPE_MS = 500
const NO_MODEL_PROVIDER_OVERVIEW_ERROR = "No model provider configured"
const NO_MODEL_PROVIDER_EMPTY_GUIDANCE = "Configure a model provider with /credentials before dispatching an agent."
const NO_MODEL_PROVIDER_CHAT_NOTICE = "No model provider configured. Open /settings and choose credentials before sending."

async function hasAvailableModelProvider() {
	return (await availableModelEntries()).length > 0
}

export class DoubleEscapeTracker {
	/** @param {number} [timeoutMs] */
	constructor(timeoutMs = DOUBLE_ESCAPE_MS) {
		this.timeoutMs = timeoutMs
		this.lastPressAt = undefined
	}

	reset() {
		this.lastPressAt = undefined
	}

	/** @param {number} [now] */
	press(now = Date.now()) {
		if (this.lastPressAt !== undefined && now - this.lastPressAt < this.timeoutMs) {
			this.reset()
			return true
		}
		this.lastPressAt = now
		return false
	}
}

/** @param {unknown} content */
function flattenContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("")
}

/** @param {string} iso */
function relativeAge(iso) {
	const at = Date.parse(iso)
	if (!Number.isFinite(at)) return ""
	const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours}h`
	return `${Math.floor(hours / 24)}d`
}

/** @param {string | undefined} iso */
function elapsedAge(iso) {
	const at = Date.parse(iso || "")
	if (!Number.isFinite(at)) return ""
	const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const restSeconds = seconds % 60
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const restMinutes = minutes % 60
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}

function elapsedDuration(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const restSeconds = seconds % 60
	if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const restMinutes = minutes % 60
	return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}

function formatCount(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
	return String(n)
}

/** @param {any} message */
export function streamingContentProgress(message) {
	let chars = 0
	let textChars = 0
	if (Array.isArray(message?.content)) {
		for (const block of message.content) {
			if (block?.type === "text") {
				const len = String(block.text ?? "").length
				chars += len
				textChars += len
			} else if (block?.type === "thinking") chars += String(block.thinking ?? "").length
			else if (block?.type === "toolCall") {
				if (typeof block.input === "string") chars += block.input.length
				else if (typeof block.partialJson === "string") chars += block.partialJson.length
				else {
					try {
						chars += JSON.stringify(block.arguments ?? {}).length
					} catch {}
				}
			}
		}
	}
	return { chars, textChars }
}

/** @param {any} message */
export function streamingStatusBase(message) {
	return streamingContentProgress(message).textChars > 0 ? "Generating…" : "Thinking…"
}

const DEFERRED_FOLDED_GROUP_LIMIT = 6

export class AgentTable {
	/** @param {{ cwd?: string, getMaxLines?: (width: number) => number, getEmptyText?: () => string, getEmptyLines?: () => Array<string | { text: string, highlight?: boolean }> }} [options] */
	constructor(options = {}) {
		/** @type {any[]} */
		this.sessions = []
		/** @type {Map<string, string>} */
		this.activity = new Map()
		this.selectedIndex = 0
		this.selectedSessionId = undefined
		this.peekSessionId = undefined
		this.filter = ""
		this.notice = ""
		this.expandedGroups = new Set()
		this.scrollOffset = 0
		this.getMaxLines = options.getMaxLines
		this.getEmptyText = options.getEmptyText
		this.getEmptyLines = options.getEmptyLines
		this.cwd = resolve(options.cwd ?? process.cwd())
	}

	clampedIndex(index, rows = this.rows()) {
		return rows.length === 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index))
	}

	clampSelection() {
		this.selectedIndex = this.clampedIndex(this.selectedIndex)
	}

	/** @param {any} session */
	isSelectionTerminal(session) {
		const state = this.stateFor(session)
		return state === "deferred" || state === "completed"
	}

	/** @param {string | undefined} id */
	visibleSessionIndex(id) {
		if (!id) return -1
		return this.rows().findIndex((row) => row.type !== "more" && row.id === id)
	}

	/**
	 * @param {number} preferredIndex
	 * @param {{ excludeSessionId?: string }} [options]
	 */
	selectFallback(preferredIndex = this.selectedIndex, options = {}) {
		const rows = this.rows()
		if (rows.length === 0) {
			this.selectedIndex = 0
			this.selectedSessionId = undefined
			return false
		}

		const anchor = this.clampedIndex(preferredIndex, rows)
		const candidates = rows
			.map((row, index) => ({ row, index }))
			.filter(({ row }) => row.type !== "more" && row.id !== options.excludeSessionId)
		if (candidates.length === 0) {
			this.selectedIndex = anchor
			this.selectedSessionId = undefined
			return false
		}

		const selected = candidates.reduce((best, candidate) => {
			const bestDistance = Math.abs(best.index - anchor)
			const candidateDistance = Math.abs(candidate.index - anchor)
			return candidateDistance < bestDistance ? candidate : best
		})
		this.selectedIndex = selected.index
		this.selectedSessionId = selected.row.id
		return true
	}

	/**
	 * @param {string | undefined} id
	 * @param {{ expandGroups?: boolean }} [options]
	 */
	selectSession(id, options = {}) {
		if (!id) return false
		const selectVisible = () => {
			const index = this.visibleSessionIndex(id)
			if (index === -1) return false
			this.selectedIndex = index
			this.selectedSessionId = id
			return true
		}
		if (selectVisible()) return true
		if (options.expandGroups !== false) {
			const session = this.sessions.find((s) => s.id === id)
			if (session) {
				this.expandedGroups.add(this.groupFor(session))
				if (selectVisible()) return true
			}
		}
		return false
	}

	setSelectedIndex(index) {
		const rows = this.rows()
		this.selectedIndex = this.clampedIndex(index, rows)
		const selected = rows[this.selectedIndex]
		this.selectedSessionId = selected?.type === "more" ? undefined : selected?.id
	}

	/** @param {any[]} sessions */
	setSessions(sessions) {
		const previousSelectedId = this.selectedSessionId
		const previousSelectedIndex = this.selectedIndex
		const hadRows = this.rows().length > 0
		const previousSelected = previousSelectedId ? this.sessions.find((s) => s.id === previousSelectedId) : undefined
		const wasTerminal = previousSelected ? this.isSelectionTerminal(previousSelected) : false
		this.sessions = sessions

		if (previousSelectedId) {
			const nextSelected = this.sessions.find((s) => s.id === previousSelectedId)
			const switchedToTerminal = nextSelected && !wasTerminal && this.isSelectionTerminal(nextSelected)
			if (nextSelected && !switchedToTerminal) {
				const visibleIndex = this.visibleSessionIndex(previousSelectedId)
				if (visibleIndex !== -1) this.selectedIndex = visibleIndex
				else this.clampSelection()
				return
			}
			this.selectFallback(previousSelectedIndex, { excludeSessionId: switchedToTerminal ? previousSelectedId : undefined })
			return
		}

		if (hadRows) {
			const rows = this.rows()
			this.selectedIndex = this.clampedIndex(previousSelectedIndex, rows)
			const selected = rows[this.selectedIndex]
			this.selectedSessionId = selected?.type === "more" ? undefined : selected?.id
			return
		}
		this.selectFallback(previousSelectedIndex)
	}

	/** @param {string} filter */
	setFilter(filter) {
		this.filter = filter.trim().toLowerCase()
		if (this.selectedSessionId && this.visibleSessionIndex(this.selectedSessionId) !== -1) {
			this.selectedIndex = this.visibleSessionIndex(this.selectedSessionId)
			return
		}
		this.selectFallback(0)
	}

	/**
	 * @param {string} sessionId
	 * @param {string} text
	 */
	setActivity(sessionId, text) {
		this.activity.set(sessionId, text)
	}

	clearActivity(sessionId) {
		this.activity.delete(sessionId)
	}

	/** @param {string} text */
	setNotice(text) {
		this.notice = text
	}

	rows() {
		let sessions = this.sessions
		if (this.filter) {
			sessions = sessions.filter((s) => {
				const haystack = [s.id, s.cwd, s.agentView?.projectTag, s.agentView?.descriptionInUi, s.agentView?.description, s.preview?.first?.text, s.preview?.lastUser?.text]
					.filter(Boolean)
					.join("\n")
					.toLowerCase()
				return haystack.includes(this.filter)
			})
		}
		const priority = { needs_input: 0, experiencing_problems: 1, queued: 2, ready_for_review: 3, working: 4, not_started: 5, deferred: 6, completed: 7 }
		const sorted = sessions
			.slice()
			.sort((a, b) => {
				const stateA = this.stateFor(a)
				const stateB = this.stateFor(b)
				const pa = priority[stateA] ?? 7
				const pb = priority[stateB] ?? 7
				if (pa !== pb) return pa - pb
				const timestampA = stateA === "working" ? a.latestRunStartedAt ?? a.createdAt ?? a.updatedAt : a.updatedAt
				const timestampB = stateB === "working" ? b.latestRunStartedAt ?? b.createdAt ?? b.updatedAt : b.updatedAt
				return String(timestampB ?? "").localeCompare(String(timestampA ?? ""))
			})
		const out = []
		let group = ""
		let groupSessions = []
		const flush = () => {
			if (!group) return
			const foldable = group === "Deferred"
			const expanded = this.expandedGroups.has(group) || this.filter
			const visible = foldable && !expanded ? groupSessions.slice(0, DEFERRED_FOLDED_GROUP_LIMIT) : groupSessions
			out.push(...visible)
			const hidden = groupSessions.length - visible.length
			if (hidden > 0) out.push({ type: "more", id: `more:${group}`, group, count: hidden })
		}
		for (const session of sorted) {
			const nextGroup = this.groupFor(session)
			if (nextGroup !== group) {
				flush()
				group = nextGroup
				groupSessions = []
			}
			groupSessions.push(session)
		}
		flush()
		return out
	}

	selectedEntry() {
		return this.rows()[this.selectedIndex]
	}

	selected() {
		const entry = this.selectedEntry()
		return entry?.type === "more" ? undefined : entry
	}

	activateMore() {
		const entry = this.selectedEntry()
		if (entry?.type !== "more") return false
		this.expandedGroups.add(entry.group)
		return true
	}

	move(delta) {
		const n = this.rows().length
		if (n === 0) {
			this.selectedIndex = 0
			this.selectedSessionId = undefined
			return
		}
		this.setSelectedIndex(this.selectedIndex + delta)
	}

	page(delta) {
		this.move(delta * 10)
	}

	togglePeek() {
		const selected = this.selected()
		if (!selected) return
		this.peekSessionId = this.peekSessionId === selected.id ? undefined : selected.id
	}

	invalidate() {}

	/** @param {number} width */
	render(width) {
		const maxLines = this.getMaxLines?.(width)
		const header = this.renderHeader(width)
		const body = this.renderBody(width)
		if (!Number.isFinite(maxLines)) return [...header, ...body.lines]

		const lineLimit = Math.max(0, Math.floor(maxLines))
		if (lineLimit <= header.length) return header.slice(0, lineLimit)

		const viewport = clipLinesToViewport({
			lines: body.lines,
			maxLines: lineLimit - header.length,
			anchorLine: body.selectedLine,
			scrollOffset: this.scrollOffset,
			topIndicator: (hidden) => theme.dim(fit(`↑ ${hidden} more`, width)),
			bottomIndicator: (hidden) => theme.dim(fit(`↓ ${hidden} more`, width)),
		})
		this.scrollOffset = viewport.scrollOffset
		return [...header, ...viewport.lines]
	}

	/** @param {number} width */
	renderHeader(width) {
		/** @type {string[]} */
		const lines = []
		lines.push(leftRightLine(theme.bold("pinano"), compactHomePath(this.cwd), width))
		if (this.notice) lines.push(theme.dim(fit(this.notice, width)))
		if (this.filter) lines.push(theme.dim(fit(`filter: ${this.filter}`, width)))
		lines.push("")
		return lines
	}

	/** @param {number} width */
	renderBody(width) {
		const rows = this.rows()
		/** @type {string[]} */
		const lines = []
		let selectedLine = 0

		if (rows.length === 0) {
			const emptyLines = this.getEmptyLines?.() ?? [this.getEmptyText?.() ?? "No sessions yet. Type a task below and press Enter to dispatch an agent."]
			for (const entry of emptyLines) {
				const text = typeof entry === "string" ? entry : entry.text
				const render = typeof entry === "string" || !entry.highlight ? theme.dim : theme.yellow
				for (const line of text.split("\n")) lines.push(render(fit(line, width)))
			}
			return { lines, selectedLine }
		}

		let lastGroup = ""
		rows.forEach((entry, index) => {
			const group = entry.type === "more" ? entry.group : this.groupFor(entry)
			if (group !== lastGroup) {
				if (lastGroup) lines.push("")
				lines.push(theme.cyan(fit(group, width)))
				lastGroup = group
			}
			const selected = index === this.selectedIndex
			if (entry.type === "more") {
				const line = this.renderMoreRow(entry, selected, width)
				if (selected) selectedLine = lines.length
				lines.push(selected ? theme.bg("selectedBg", line) : line)
				return
			}
			const line = this.renderRow(entry, selected, width)
			if (selected) selectedLine = lines.length
			lines.push(selected ? theme.bg("selectedBg", line) : line)
			if (this.peekSessionId === entry.id) {
				for (const peekLine of this.renderPeek(entry, width)) lines.push(peekLine)
			}
		})
		return { lines, selectedLine }
	}

	/** @param {any} session */
	stateFor(session) {
		if (/^error:/.test(this.activity.get(session.id) || "")) return "needs_input"
		const lifecycleState = this.lifecycleStateFor(session)
		if (lifecycleState === "queued") return "queued"
		if (lifecycleState === "running") return "working"
		if (session.runStatus === "failed" || session.runStatus === "aborted" || session.runStatus === "interrupted") return "needs_input"
		if (lifecycleState === "not_started" && !session.agentView) return "not_started"
		const state = session.agentView?.state
		if (state === "legacy") return "completed"
		if (state === "needs_input" || state === "deferred" || state === "completed" || state === "experiencing_problems") return state
		if (state === "ready_for_review" || state === null || state === undefined) return "ready_for_review"
		if (session.agentViewFallbackState === "legacy") return "completed"
		if (session.agentViewFallbackState === "needs_input" || session.agentViewFallbackState === "ready_for_review" || session.agentViewFallbackState === "deferred" || session.agentViewFallbackState === "completed" || session.agentViewFallbackState === "experiencing_problems") return session.agentViewFallbackState
		return "not_started"
	}

	/** @param {any} session */
	lifecycleStateFor(session) {
		const activity = this.activity.get(session.id) || ""
		if (activity === "queued") return "queued"
		if (/^(Thinking|Generating|Running)/.test(activity)) return "running"
		if (session.lifecycleState) return session.lifecycleState
		if (session.runStatus === "running" || session.runtimeState === "running") return "running"
		const hasVisibleConversation = Boolean(session.preview?.first || session.preview?.lastUser)
		if ((session.runStatus === undefined || session.runStatus === "idle") && !hasVisibleConversation && !session.agentView) return "not_started"
		return "stopped"
	}

	/** @param {any} session */
	groupFor(session) {
		const state = this.stateFor(session)
		if (state === "needs_input") return "Needs input"
		if (state === "experiencing_problems") return "Experiencing problems"
		if (state === "queued") return "Starting"
		if (state === "ready_for_review") return "Ready for review"
		if (state === "working") return "Working"
		if (state === "not_started") return "Not started"
		if (state === "deferred") return "Deferred"
		return "Completed"
	}

	/** @param {any} session */
	iconFor(session) {
		const lifecycleState = this.lifecycleStateFor(session)
		const runtimeState = session.runtimeState || session.runStatus || "idle"
		if (lifecycleState === "queued") return theme.cyan("◌")
		if (lifecycleState === "running" || runtimeState === "running") return theme.cyan("✽")
		if (runtimeState === "failed") return theme.red("✖")
		if (runtimeState === "aborted" || runtimeState === "interrupted" || runtimeState === "paused") return theme.yellow("■")
		return theme.gray("∙")
	}

	/**
	 * @param {any} row
	 * @param {boolean} selected
	 * @param {number} width
	 */
	renderMoreRow(row, selected, width) {
		const prefix = `${selected ? "›" : " "} ${theme.gray("…")} `
		return fit(`${prefix}${row.count} more ${row.group.toLowerCase()} — press Enter/Space to show`, width)
	}

	/** @param {any} session */
	projectLabelFor(session) {
		return singleLine(session.agentView?.projectTag || "")
	}

	/**
	 * @param {any} session
	 * @param {boolean} selected
	 * @param {number} width
	 */
	renderRow(session, selected, width) {
		const description = session.agentView?.description || session.preview?.first?.text || session.preview?.lastUser?.text || this.activity.get(session.id) || session.id.slice(0, 8)
		const age = relativeAge(session.updatedAt)
		const prefix = `${selected ? "›" : " "} ${this.iconFor(session)} `
		const suffix = age ? ` ${theme.dim(age)}` : ""
		const available = Math.max(10, width - visibleWidth(stripAnsi(prefix)) - visibleWidth(stripAnsi(suffix)))
		const projectLabel = this.projectLabelFor(session)
		const labelWidth = projectLabel ? Math.max(1, Math.min(24, Math.floor(available * 0.3))) : 0
		const renderedLabel = projectLabel ? truncateToWidth(projectLabel, labelWidth, "", false) : ""
		const descriptionWidth = Math.max(1, available - visibleWidth(renderedLabel) - (renderedLabel ? 1 : 0))
		const rowBody = renderedLabel
			? `${theme.dim(renderedLabel)} ${fit(description.replace(/\s+/g, " "), descriptionWidth)}`
			: fit(description.replace(/\s+/g, " "), available)
		const text = `${prefix}${rowBody}${suffix}`
		return fit(text, width)
	}

	/** @param {any} session */
	summaryFor(session) {
		if (session.agentView?.descriptionInUi || session.agentView?.description) return session.agentView.descriptionInUi ?? session.agentView.description
		if (this.lifecycleStateFor(session) === "queued") return "queued"
		if (this.lifecycleStateFor(session) === "not_started") return "not started"
		if (session.runStatus === "running") return "working"
		if (session.runStatus === "failed") return "failed"
		if (session.runStatus === "aborted") return "aborted"
		if (session.runStatus === "interrupted") return "interrupted"
		return session.preview?.first?.text || session.preview?.lastUser?.text || "ready"
	}

	/**
	 * @param {any} session
	 * @param {number} width
	 */
	renderPeek(session, width) {
		const lines = []
		const indent = "    "
		const add = (label, value) => {
			const text = singleLine(value)
			if (!text) return
			lines.push(theme.dim(fit(`${indent}${label}: ${text}`, width)))
		}
		add("id", session.id)
		add("project", session.agentView?.projectTag)
		add("cwd", session.cwd)
		add("status", this.groupFor(session))
		add("description", session.agentView?.descriptionInUi ?? session.agentView?.description)
		add("activity", this.activity.get(session.id))
		add("first", session.preview?.first?.text)
		add("last user", session.preview?.lastUser?.text)
		lines.push(theme.dim(fit(`${indent}Type below to reply to this session; Enter sends, → opens.`, width)))
		return lines
	}
}

class PromptLabel {
	/** @param {() => string} text */
	constructor(text) {
		this.text = text
	}
	invalidate() {}
	lineCount() {
		return this.text() ? 1 : 0
	}
	/** @param {number} width */
	render(width) {
		const text = this.text()
		return text ? [theme.dim(fit(text, width))] : []
	}
}

class OverviewModelLine {
	/** @param {() => string} text */
	constructor(text) {
		this.text = text
	}
	invalidate() {}
	lineCount() {
		return this.text() ? 1 : 0
	}
	/** @param {number} width */
	render(width) {
		const text = this.text()
		return text ? [fit(text, width)] : []
	}
}

export class OverviewKeyHints {
	/** @param {() => { filterMode?: boolean, peeking?: boolean, hasText?: boolean }} state */
	constructor(state) {
		this.state = state
	}
	invalidate() {}
	/** @param {number} width */
	render(width) {
		const state = this.state()
		if (state.filterMode) return renderKeyHints([
			["Enter", "apply"],
			["Esc", "clear"],
			["Ctrl+F", "close"],
		], width)
		if (state.peeking && state.hasText) return renderKeyHints([
			["Enter", "reply"],
			["Ctrl+J", "newline"],
			["Ctrl+V", "image"],
			["Esc", "clear"],
			["/help", "more"],
		], width)
		if (state.hasText) return renderKeyHints([
			["Enter", "dispatch"],
			["Ctrl+J", "newline"],
			["Ctrl+V", "image"],
			["Esc", "clear"],
			["/help", "more"],
		], width)
		if (state.peeking) return renderKeyHints([
			["Enter/→", "open"],
			["↑/↓", "move"],
			["Ctrl+F", "filter"],
			["Ctrl+V", "image"],
			["Ctrl+D", "done"],
			["/help", "more"],
		], width)
		return renderKeyHints([
			["Enter/→", "open"],
			["↑/↓", "move"],
			["Ctrl+F", "filter"],
			["Ctrl+V", "image"],
			["Ctrl+D", "done"],
			["/help", "more"],
		], width)
	}
}

export class SessionKeyHints {
	/** @param {() => { hasText?: boolean, interruptible?: boolean }} state */
	constructor(state) {
		this.state = state
	}
	invalidate() {}
	/** @param {number} width */
	render(width) {
		const state = this.state()
		if (state.hasText) return renderKeyHints([
			["Enter", "send"],
			["Ctrl+J", "newline"],
			["Ctrl+V", "image"],
			["Esc Esc", "clear"],
			["Ctrl+C", "detach"],
			["/help", "more"],
		], width)
		const hints = /** @type {Array<[string, string]>} */ ([
			["←", "back"],
		])
		if (state.interruptible) hints.push(["Esc", "interrupt"])
		hints.push(["Ctrl+V", "image"], ["Ctrl+C", "detach"], ["/help", "more"])
		return renderKeyHints(hints, width)
	}
}

/** @param {any} event */
export function eventIsServiceStreamRecovery(event) {
	return event?.type === "service_event_stream_reconnected"
}

/** @param {any} event */
export function eventNeedsServiceChatSnapshot(event) {
	return eventIsServiceStreamRecovery(event) || eventInvalidatesSessionSnapshot(event) || [
		"compaction",
		"error",
	].includes(event?.type)
}

/** @param {any} event */
export function eventNeedsServiceSessionRefresh(event) {
	return eventIsServiceStreamRecovery(event) || eventInvalidatesSessionList(event) || [
		"agent_start",
		"agent_end",
		"agent_view_metadata",
		"compaction",
		"error",
		"message_end",
	].includes(event?.type)
}

/**
 * @param {() => Promise<void>} run
 * @param {(err: any) => void} onError
 * @param {number} delayMs
 */
function createCoalescedRunner(run, onError, delayMs = 120) {
	let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)
	let running = false
	let queued = false
	const flush = () => {
		timer = undefined
		if (running) {
			queued = true
			return
		}
		queued = false
		running = true
		Promise.resolve()
			.then(run)
			.catch(onError)
			.finally(() => {
				running = false
				if (queued) schedule()
			})
	}
	const schedule = (immediate = false) => {
		queued = true
		if (timer || running) return
		if (immediate) flush()
		else timer = setTimeout(flush, delayMs)
	}
	schedule.cancel = () => {
		if (timer) clearTimeout(timer)
		timer = undefined
		queued = false
	}
	return schedule
}

const OVERVIEW_COMMANDS = [
	{ name: "help", description: "show overview commands" },
	{ name: "hotkeys", description: "show overview hotkeys" },
	{ name: "web", description: "open Pinano Web overview" },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "debug-log", description: "show captured stderr; /debug-log clear resets it", takesArgs: true },
	{ name: "model", description: "select model for new sessions", takesArgs: true },
	{ name: "credentials", description: "manage ChatGPT/API-key credentials" },
	{ name: "settings", description: "edit local settings" },
	{ name: "reasoning", description: "set default reasoning effort for new sessions", rejectArgs: true },
	{ name: "reload", description: "reload settings/auth caches" },
]
const commandsWithWebSetting = (commands, settings) => commands.filter((command) => command.name !== "web" || settings?.web === true)
const commandMap = (commands) => new Map(commands.map((command) => [command.name, command]))
const isWebSlashCommand = (text) => /^\/web(?:\s|$)/.test(text.trim())

function overviewCommands(settings) {
	return commandsWithWebSetting(OVERVIEW_COMMANDS, settings)
}

const SERVICE_CHAT_COMMANDS = [
	{ name: "help", description: "show service chat commands" },
	{ name: "hotkeys", description: "show hotkeys" },
	{ name: "web", description: "open this session in Pinano Web" },
	{ name: "branch", description: "create a new session from the current conversation branch" },
	{ name: "rewind", description: "rewind to a previous user message or switch to a branch tip", rejectArgs: true },
	{ name: "session", description: "show current session details" },
	{ name: "reasoning", description: "set reasoning effort for this session", rejectArgs: true },
	{ name: "fast", description: "set Codex Fast mode for this session: /fast on|off|status", takesArgs: true },
	{ name: "compact", description: "compact older conversation messages" },
	{ name: "context", description: "show context usage estimate" },
	{ name: "system", description: "show system prompt, tools, and project context" },
	{ name: "settings", description: "edit local settings" },
	{ name: "reload", description: "reload settings/auth caches" },
	{ name: "usage", description: "show ChatGPT/Codex usage limits" },
	{ name: "continue", description: "resume an interrupted turn, or ask the model to continue" },
	{ name: "abort", description: "abort the current turn" },
]

function serviceChatCommandMap(settings) {
	return commandMap(commandsWithWebSetting(SERVICE_CHAT_COMMANDS, settings))
}

function serviceChatCommandsForModel(model, settings) {
	return commandsWithWebSetting(SERVICE_CHAT_COMMANDS, settings)
		.filter((command) => command.name !== "fast" || isFastModeEligibleModel(model))
}

const commandLineFor = (commands, text) => {
	const trimmed = text.trim()
	if (!trimmed.startsWith("/")) return null
	const commandLine = trimmed.slice(1).trim()
	const [name = "", ...rest] = commandLine.split(/\s+/)
	const command = commands.get(name)
	if (!command) return null
	// Parse old argument forms for interactive-only commands so the UI can reject them locally instead of sending them as prompts.
	if (rest.length > 0 && !command.takesArgs && !command.rejectArgs) return null
	return commandLine
}

/**
 * @param {string} text
 * @returns {string | null} command line without the leading slash, or null if it is not a known command
 */
export function overviewCommandLine(text, settings = undefined) {
	return commandLineFor(commandMap(overviewCommands(settings)), text)
}

/**
 * @param {string} text
 * @returns {string | null} command line without the leading slash, or null if it is not a known command
 */
export function serviceChatCommandLine(text, settings = undefined) {
	return commandLineFor(serviceChatCommandMap(settings), text)
}

export function sessionOpenCommand(sessionId) {
	return `pinano open ${routeToArg(sessionRoute(sessionId.slice(0, 8)))}`
}

export function webUrlForRoute(web, route = overviewRoute) {
	if (!web?.url) return ""
	const url = new URL(web.url)
	const routeUrl = new URL(routeToArg(route), url)
	url.pathname = routeUrl.pathname
	url.searchParams.delete("model")
	for (const [key, value] of routeUrl.searchParams) url.searchParams.set(key, value)
	url.hash = routeUrl.hash
	return url.href
}

async function webForOpening(client) {
	const status = await client.webStatus()
	const web = status.web?.running ? status.web : (await client.startWeb()).web
	if (!web?.url) throw new Error("web server did not return a URL")
	return web
}

function commandHelpBody(commands, extraLines = []) {
	const width = Math.max(...commands.map((c) => c.name.length), 4)
	return [
		...commands.map((command) => `/${command.name.padEnd(width)}  ${command.description}`),
		...extraLines,
	].join("\n")
}

async function showCodexUsageModal(tui, baseUrl, onPayload) {
	try {
		const payload = await fetchCodexUsage({ baseUrl })
		onPayload?.(payload)
		await showTextModal(tui, "ChatGPT/Codex usage", formatCodexUsage(payload).join("\n"))
	} catch (err) {
		await showTextModal(tui, "Usage error", String(err?.message ?? err))
	}
}

async function showDebugLogModal(tui, stderrCapture, arg) {
	if (!stderrCapture) {
		await showTextModal(tui, "Debug log", "stderr capture not enabled")
		return
	}
	if (arg === "clear") {
		stderrCapture.clear()
		await showTextModal(tui, "Debug log", "debug log cleared")
		return
	}
	const entries = stderrCapture.entries()
	if (entries.length === 0) {
		await showTextModal(tui, "Debug log", "no stderr captured")
		return
	}
	await showTextModal(tui, "Debug log", entries.map((entry) => {
		const time = new Date(entry.time).toISOString().slice(11, 19)
		return `${time}  ${entry.text}`
	}).join("\n"))
}

async function loadSubscriptionProviders() {
	const next = new Set()
	for (const provider of await listProviders()) {
		const cred = await getCredential(provider)
		if (cred?.kind === "codex") next.add(provider)
	}
	return next
}

const providerLabel = (provider) => API_KEY_PROVIDER_INFOS.find((info) => info.provider === provider)?.label ?? provider

/** @param {string} secret */
function maskSecret(secret) {
	const value = secret.trim()
	if (!value) return ""
	if (value.length <= 8) return "••••"
	return `${value.slice(0, 4)}…${value.slice(-4)}`
}

async function saveCodexCredentials(credentials) {
	await setCredential("openai-codex", {
		kind: "codex",
		access: credentials.access,
		refresh: credentials.refresh,
		idToken: credentials.idToken,
		accountId: credentials.accountId,
		expiresAt: credentials.expires,
		createdAt: Date.now(),
	})
}

async function ensureConfiguredDefaultModel({ setDefaultModel, onSettingsChanged } = {}) {
	const settings = await loadSettings()
	const models = await availableModelEntries()
	if (models.length === 0) return settings
	if (models.some((entry) => modelRefMatches(entry, settings.model))) return settings
	const next = modelRef(models[0])
	const updated = await setDefaultModel?.(next) ?? await updateSetting("model", next)
	await onSettingsChanged?.(updated)
	return updated
}

class ChatGptOAuthModal extends RetainedComponent {
	constructor(tui, { onCancel } = {}) {
		super()
		this.tui = tui
		this.onCancel = onCancel
		this.onManualCode = undefined
		this.status = "Starting ChatGPT OAuth…"
		this.instructions = "Complete the login in your browser, then return to Pinano."
		this.url = ""
		this.cancelled = false
		this.manualCodeBusy = false
		this.focused = false
		this.input = new Input()
		this.input.onSubmit = (value) => void this.submitManualCode(value)
		this.input.onEscape = () => this.cancel()
	}

	setAuth({ url, instructions }) {
		this.url = url
		this.instructions = instructions || this.instructions
		this.markDirty()
		this.tui.requestRender()
	}

	setManualCodeSubmitHandler(handler) {
		this.onManualCode = handler
		this.markDirty()
		this.tui.requestRender()
	}

	setStatus(status) {
		this.status = status
		this.markDirty()
		this.tui.requestRender()
	}

	cancel() {
		if (this.cancelled) return
		this.cancelled = true
		this.setStatus("Cancelling ChatGPT login…")
		this.onCancel?.()
	}

	async submitManualCode(value) {
		const input = value.trim()
		if (this.cancelled || this.manualCodeBusy) return
		if (!input) {
			this.setStatus("Paste the authorization code or full redirect URL, then press Enter.")
			return
		}
		this.manualCodeBusy = true
		this.input.setValue("")
		this.setStatus("Authorization code submitted; finishing login.")
		try {
			await this.onManualCode?.(input)
		} finally {
			this.manualCodeBusy = false
			this.markDirty()
			this.tui.requestRender()
		}
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings()
		if (data === "\x03") {
			this.cancel()
			return
		}
		if (this.manualCodeBusy && !kb.matches(data, "tui.select.cancel")) return
		this.input.handleInput(data)
		this.markDirty()
	}

	/** @param {number} width */
	render(width) {
		const modalWidth = Math.max(44, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const height = Math.max(12, this.tui.terminal?.rows ?? 24)
		const border = theme.fg("border", "─".repeat(modalWidth))
		this.input.focused = this.focused && !this.cancelled
		const lines = [
			border,
			fit(theme.bold(" ChatGPT subscription login"), modalWidth),
			border,
			...wrapTextWithAnsi(theme.dim(` ${this.instructions}`), modalWidth).map((line) => fit(line, modalWidth)),
			border,
			fit(theme.bold(" Authorization code or redirect URL"), modalWidth),
			...this.input.render(innerWidth).map((line) => fit(`  ${line}`, modalWidth)),
		]
		if (this.url) {
			lines.push(border)
			lines.push(fit(theme.bold(" Login URL"), modalWidth))
			lines.push(...wrapTextWithAnsi(` ${hyperlink(this.url, this.url)}`, modalWidth).map((line) => fit(line, modalWidth)))
		}
		lines.push(border)
		lines.push(...wrapTextWithAnsi(` ${this.cancelled ? theme.cyan("Cancelling…") : theme.cyan("Status:")} ${this.status}`, modalWidth).map((line) => fit(line, modalWidth)))
		lines.push(border)
		lines.push(fit(theme.dim(" Enter submit · Esc cancel ChatGPT login"), modalWidth))
		while (lines.length < height) lines.push(fit("", modalWidth))
		return lines
	}
}

export class CredentialsSettingsModal extends RetainedComponent {
	constructor(tui, options = {}) {
		super()
		this.tui = tui
		this.options = options
		this.rows = []
		this.selectedIndex = 0
		this.status = options.onboarding
			? "Choose a model provider before starting."
			: ""
		this.busy = false
		this.onClose = undefined
		this.stored = new Map()
		this.envKeys = []
	}

	async reload() {
		this.stored = new Map()
		for (const provider of await listProviders()) this.stored.set(provider, await getCredential(provider))
		this.envKeys = detectedEnvApiKeys()
		this.rebuildRows()
	}

	rebuildRows() {
		const codex = this.stored.get("openai-codex")
		const envProviders = new Set(this.envKeys.map((candidate) => candidate.provider))
		this.rows = [
			{
				id: "chatgpt",
				kind: "chatgpt",
				label: "Use your ChatGPT subscription",
				value: codex?.kind === "codex" ? `connected${codex.accountId ? ` · ${codex.accountId}` : ""}` : "OAuth",
				description: "Starts the OpenAI OAuth flow. Usage is subject to your ChatGPT plan and OpenAI's terms.",
			},
			{ id: "spacer:api-keys", kind: "spacer", label: "", value: "" },
			{ id: "section:api-keys", kind: "section", label: "API keys", value: "" },
		]

		if (this.envKeys.length > 0) {
			this.rows.push(...this.envKeys.map((candidate) => {
				const credential = this.stored.get(candidate.provider)
				const saved = credential?.kind === "apiKey"
				const differs = saved && credential.apiKey !== candidate.apiKey
				return {
					id: `env:${candidate.provider}:${candidate.envVar}`,
					kind: "env-api-key",
					candidate,
					label: `${saved ? differs ? "Update" : "Saved" : "Save"} ${candidate.envVar}`,
					value: `${saved ? "[x]" : "[ ]"}${differs ? " env differs" : saved ? " saved" : ""}`,
					description: saved
						? differs
							? `A different ${candidate.providerLabel} API key is saved. Space updates Pinano to the environment value (${maskSecret(candidate.apiKey)}). Select it again after updating to remove it.`
							: `${candidate.providerLabel} API key is saved (${maskSecret(candidate.apiKey)}). Space removes it from Pinano.`
						: `Detected ${candidate.providerLabel} API key in the environment (${maskSecret(candidate.apiKey)}). Space saves it to Pinano's credential store.`,
				}
			}))
		} else {
			this.rows.push({
				id: "env-none",
				kind: "noop",
				label: "Environment API keys",
				value: "none found",
				description: "Launch Pinano with OPENAI_API_KEY, MOONSHOT_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY, or LLAMACPP_API_KEY to import supported API keys here.",
			})
		}

		this.rows.push({
			id: "manual-api-key",
			kind: "manual-api-key",
			label: "Add a different API key…",
			value: "",
			description: "Enter an API key manually for OpenAI, Moonshot, DeepSeek, or a local OpenAI-compatible endpoint.",
		})

		for (const [provider, credential] of this.stored) {
			if (credential?.kind === "codex") this.rows.push({
				id: `remove:${provider}`,
				kind: "remove",
				provider,
				label: "Remove ChatGPT subscription",
				value: credential.accountId ?? "connected",
				description: "Deletes the stored OAuth refresh token from Pinano.",
			})
			else if (credential?.kind === "apiKey" && !envProviders.has(provider)) this.rows.push({
				id: `remove:${provider}`,
				kind: "remove",
				provider,
				label: `Remove ${providerLabel(provider)} API key`,
				value: "saved",
				description: "Deletes the stored API key from Pinano. This does not change environment variables or service.json.",
			})
		}

		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1))
		if (!this.isSelectableRow(this.rows[this.selectedIndex])) this.selectedIndex = this.firstSelectableIndex()
		this.markDirty()
		this.tui.requestRender()
	}

	isSelectableRow(row) {
		return row && row.kind !== "spacer" && row.kind !== "section" && row.kind !== "noop"
	}

	firstSelectableIndex() {
		const index = this.rows.findIndex((row) => this.isSelectableRow(row))
		return index >= 0 ? index : 0
	}

	moveSelection(direction, steps = 1) {
		if (this.rows.length === 0) return
		for (let moved = 0; moved < steps; moved++) {
			for (let attempt = 0; attempt < this.rows.length; attempt++) {
				this.selectedIndex = (this.selectedIndex + direction + this.rows.length) % this.rows.length
				if (this.isSelectableRow(this.rows[this.selectedIndex])) break
			}
		}
		this.markDirty()
		this.tui.requestRender()
	}

	/** @param {string} message */
	setStatus(message) {
		this.status = message
		this.markDirty()
		this.tui.requestRender()
	}

	async afterCredentialChange(message) {
		await this.options.refreshAuthCache?.()
		const settings = await ensureConfiguredDefaultModel({
			setDefaultModel: this.options.setDefaultModel,
			onSettingsChanged: this.options.onSettingsChanged,
		})
		await this.reload()
		this.setStatus(message + (settings?.model ? ` · default model: ${settings.model}` : ""))
	}

	async startChatGptOAuth() {
		this.busy = true
		this.setStatus("Starting ChatGPT OAuth…")
		const controller = new AbortController()
		const manualPromptController = new AbortController()
		const oauthModal = new ChatGptOAuthModal(this.tui, {
			onCancel: () => {
				controller.abort()
				manualPromptController.abort()
			},
		})
		const manualInputs = []
		const manualWaiters = []
		let requestManualCode
		let manualRequestBusy = false
		const provideManualInput = (value) => {
			const waiter = manualWaiters.shift()
			if (waiter) waiter(value)
			else manualInputs.push(value)
		}
		const waitForManualInput = (signal) => {
			if (manualInputs.length > 0) return Promise.resolve(manualInputs.shift())
			return new Promise((resolve) => {
				let done = false
				const waiter = (value) => {
					if (done) return
					done = true
					signal?.removeEventListener("abort", abort)
					resolve(value)
				}
				const abort = () => {
					const index = manualWaiters.indexOf(waiter)
					if (index !== -1) manualWaiters.splice(index, 1)
					waiter(null)
				}
				manualWaiters.push(waiter)
				if (signal?.aborted) abort()
				else signal?.addEventListener("abort", abort, { once: true })
			})
		}
		const runManualCodeRequest = async () => {
			if (!requestManualCode || manualRequestBusy) return
			manualRequestBusy = true
			try {
				const result = await requestManualCode()
				if (result?.status === "submitted") oauthModal.setStatus("Authorization code submitted; finishing login.")
				else if (result?.status === "cancelled") oauthModal.setStatus("Still waiting for ChatGPT login.")
				else if (result?.status === "busy") oauthModal.setStatus("Authorization code submission is already in progress.")
				else if (result?.status === "error") oauthModal.setStatus(`Could not use authorization code: ${result.error?.message ?? result.error}`)
			} finally {
				manualRequestBusy = false
			}
		}
		oauthModal.setManualCodeSubmitHandler(async (value) => {
			provideManualInput(value)
			if (requestManualCode) await runManualCodeRequest()
			else oauthModal.setStatus("Authorization code submitted; finishing login.")
		})
		const oauthHandle = this.tui.showOverlay(oauthModal, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			backdrop: true,
		})
		let closeAfterOAuth = false
		try {
			const credentials = await (this.options.loginCodex ?? loginCodex)({
				signal: controller.signal,
				onAuth: ({ url, instructions, requestManualCode: nextRequestManualCode }) => {
					requestManualCode = nextRequestManualCode
					oauthModal.setAuth({ url, instructions })
					oauthModal.setStatus("Complete ChatGPT login in your browser.")
					if (requestManualCode && manualInputs.length > 0) void runManualCodeRequest()
					this.setStatus(`Complete ChatGPT login in your browser. If it did not open, visit: ${url}`)
					void openUrlInBrowser(url).then((opened) => {
						if (controller.signal.aborted) return
						oauthModal.setStatus(opened ? "Browser opened. Complete ChatGPT login to finish." : "Browser did not open. Use the login URL above.")
						this.setStatus(opened ? `Browser opened. Complete ChatGPT login to finish. If it did not open, visit: ${url}` : `Open this URL to finish ChatGPT login: ${url}`)
					})
				},
				onPrompt: async () => {
					oauthModal.setStatus("Paste the authorization code or full redirect URL, then press Enter.")
					return await waitForManualInput(manualPromptController.signal)
				},
			})
			await saveCodexCredentials(credentials)
			await this.afterCredentialChange(`Saved ChatGPT subscription credentials to ${authFilePath("openai-codex")}`)
			closeAfterOAuth = true
		} catch (err) {
			this.setStatus(controller.signal.aborted ? "ChatGPT login cancelled" : `ChatGPT login failed: ${err?.message ?? err}`)
		} finally {
			manualPromptController.abort()
			oauthHandle.hide()
			this.busy = false
			this.markDirty()
			this.tui.requestRender()
			if (closeAfterOAuth) this.onClose?.()
		}
	}

	async addManualApiKey() {
		const provider = await pickFromOverlay(
			this.tui,
			API_KEY_PROVIDER_INFOS.map((info) => ({ value: info.provider, label: info.label })),
			{
				title: "Add a different API key",
				subtitle: "Choose the provider this API key should be used with.",
				maxVisible: API_KEY_PROVIDER_INFOS.length,
			},
		) ?? ""
		if (!provider) {
			this.setStatus("API key entry cancelled")
			return
		}
		this.setStatus(`Paste ${providerLabel(provider)} API key.`)
		const apiKey = (await promptForInput(this.tui, `${providerLabel(provider)} API key`, {
			secret: true,
			title: `${providerLabel(provider)} API key`,
			subtitle: "Paste the key. It will be stored in Pinano's local credential store.",
		}))?.trim() ?? ""
		if (!apiKey) {
			this.setStatus("API key entry cancelled")
			return
		}
		await setCredential(provider, { kind: "apiKey", apiKey, createdAt: Date.now() })
		await this.afterCredentialChange(`Saved ${providerLabel(provider)} API key to ${authFilePath(provider)}`)
	}

	async toggleEnvApiKey(candidate) {
		const credential = this.stored.get(candidate.provider)
		if (credential?.kind === "apiKey" && credential.apiKey !== candidate.apiKey) {
			await setCredential(candidate.provider, { kind: "apiKey", apiKey: candidate.apiKey, createdAt: Date.now() })
			await this.afterCredentialChange(`Updated ${candidate.providerLabel} API key from ${candidate.envVar}`)
			return
		}
		if (credential?.kind === "apiKey") {
			await deleteCredential(candidate.provider)
			await this.afterCredentialChange(`Removed ${candidate.providerLabel} API key`)
			return
		}
		await setCredential(candidate.provider, { kind: "apiKey", apiKey: candidate.apiKey, createdAt: Date.now() })
		await this.afterCredentialChange(`Saved ${candidate.providerLabel} API key from ${candidate.envVar}`)
	}

	async removeCredential(provider) {
		const confirm = await pickFromOverlay(this.tui, [
			{ value: "remove", label: "Remove credential", description: `Delete ${providerLabel(provider)} credentials from Pinano` },
			{ value: "cancel", label: "Cancel", description: "Keep the credential" },
		], {
			title: "Remove credential",
			subtitle: "This only changes Pinano's stored credentials.",
			maxVisible: 2,
		})
		if (confirm !== "remove") {
			this.setStatus("remove cancelled")
			return
		}
		await deleteCredential(provider)
		await this.afterCredentialChange(`Removed credential for ${providerLabel(provider)}`)
	}

	async activateSelected() {
		if (this.busy) return
		const row = this.rows[this.selectedIndex]
		if (!row) return
		if (row.kind === "chatgpt") {
			await this.startChatGptOAuth()
			return
		}
		if (row.kind === "manual-api-key") {
			await this.addManualApiKey()
			return
		}
		if (row.kind === "env-api-key") {
			await this.toggleEnvApiKey(row.candidate)
			return
		}
		if (row.kind === "remove") await this.removeCredential(row.provider)
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings()
		if (!this.busy && kb.matches(data, "tui.select.cancel")) {
			this.onClose?.()
			return
		}
		if (this.busy) return
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1)
			return
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1)
			return
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-1, 8)
			return
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(1, 8)
			return
		}
		const row = this.rows[this.selectedIndex]
		if (matchesKey(data, "enter")) {
			if (row?.kind === "env-api-key") this.onClose?.()
			else void this.activateSelected().catch((err) => this.setStatus(`credentials error: ${err?.message ?? err}`))
			return
		}
		if (matchesKey(data, "space") || data === " ") {
			void this.activateSelected().catch((err) => this.setStatus(`credentials error: ${err?.message ?? err}`))
		}
	}

	/** @param {number} width */
	render(width) {
		const modalWidth = Math.max(44, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const border = theme.fg("border", "─".repeat(modalWidth))
		const selected = this.rows[this.selectedIndex]
		const maxLabelWidth = Math.min(36, Math.max(12, ...this.rows.map((row) => visibleWidth(row.label))))
		const visibleRows = clipLinesToViewport({
			lines: this.rows.map((row, index) => this.renderRow(row, index, innerWidth, maxLabelWidth)),
			maxLines: Math.max(4, Math.min(12, this.rows.length)),
			anchorLine: this.selectedIndex,
			scrollOffset: this.scrollOffset ?? 0,
			topIndicator: (hidden) => theme.dim(`↑ ${hidden} more`),
			bottomIndicator: (hidden) => theme.dim(`↓ ${hidden} more`),
		})
		this.scrollOffset = visibleRows.scrollOffset
		const subtitle = this.options.onboarding
			? "No model provider is configured yet. Pinano is currently optimized for use with a ChatGPT subscription. API keys are also supported."
			: "Pinano is currently optimized for use with a ChatGPT subscription. API keys are also supported."
		const lines = [
			border,
			fit(theme.bold(" Model provider credentials"), modalWidth),
			...wrapTextWithAnsi(theme.dim(` ${subtitle}`), modalWidth).map((line) => fit(line, modalWidth)),
			border,
			...visibleRows.lines.map((line) => fit(`  ${line}`, modalWidth)),
		]
		if (selected?.description) {
			lines.push(border)
			lines.push(...wrapTextWithAnsi(theme.dim(` ${selected.description}`), modalWidth).map((line) => fit(line, modalWidth)))
		}
		if (this.status) {
			lines.push(border)
			lines.push(...wrapTextWithAnsi(` ${this.busy ? theme.cyan("Working…") : theme.cyan("Status:")} ${this.status}`, modalWidth).map((line) => fit(line, modalWidth)))
		}
		lines.push(border)
		lines.push(fit(theme.dim(this.busy ? " Please wait…" : " ↑/↓ move · Enter open · Space toggle API keys · Esc close"), modalWidth))
		while (lines.length < (this.tui.terminal?.rows ?? 0)) lines.push(fit("", modalWidth))
		return lines
	}

	renderRow(row, index, width, labelWidth) {
		if (row.kind === "spacer") return ""
		if (row.kind === "section") return theme.dim(row.label)
		const isSelected = index === this.selectedIndex
		const prefix = isSelected ? "→ " : "  "
		const label = row.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)))
		const value = row.value ?? ""
		const raw = truncateToWidth(`${prefix}${label}  ${value}`, width)
		return isSelected ? theme.bg("selectedBg", raw) : raw
	}
}

async function showCredentialsSettings(tui, options = {}) {
	const modal = new CredentialsSettingsModal(tui, options)
	await modal.reload()
	return new Promise((resolve) => {
		const handle = tui.showOverlay(modal, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			backdrop: true,
		})
		modal.onClose = () => {
			handle.hide()
			resolve()
		}
	})
}

async function updateScopedModelsSetting(ctx, settings, notify) {
	const models = await availableModelEntries(settings)
	const rows = rowsForModels(models, { scopedModelIds: settings.scopedModelIds })
	const id = await pickModel(ctx, rows, { mode: "toggle", title: "Scoped models", subtitle: "Pick a model to add/remove from the scoped shortlist." }) ?? ""
	if (!id) return
	const next = settings.scopedModelIds.includes(id)
		? settings.scopedModelIds.filter((existing) => existing !== id)
		: [...settings.scopedModelIds, id]
	await updateSetting("scopedModelIds", next)
	notify(`scoped models: ${next.join(", ") || "(empty)"}`)
}

async function showSettingsEditor(ctx, { notify, onSettingsChanged, setDefaultModel, setDefaultReasoning, refreshAuthCache } = {}) {
	const write = notify ?? (() => {})
	while (true) {
		const settings = await loadSettings()
		const choice = await pickFromOverlay(ctx.tui, [
			{ value: "credentials", label: "credentials", description: "manage ChatGPT subscription OAuth and API keys" },
			{ value: "model", label: `model: ${settings.model}`, description: "default model id for new sessions" },
			{ value: "thinkingLevel", label: `reasoning: ${reasoningLevelLabel(settings.thinkingLevel)}`, description: "default reasoning effort for new sessions" },
			{ value: "autocompactThreshold", label: `autocompactThreshold: ${settings.autocompactThreshold}`, description: "fraction of context window before auto-compaction" },
			{ value: "scopedModelIds", label: `scopedModelIds: ${settings.scopedModelIds.length} model(s)`, description: "model shortlist shown by the model selector" },
			{ value: "doubleEscapeAction", label: `doubleEscapeAction: ${settings.doubleEscapeAction}`, description: "Esc Esc behavior" },
			{ value: "web", label: `web: ${settings.web ? "on" : "off"}`, description: "enable Pinano Web CLI and /web commands" },
			{ value: "showThinkingOutput", label: `showThinkingOutput: ${settings.showThinkingOutput ? "on" : "off"}`, description: "show model reasoning text in the transcript" },
			{ value: "showToolOutput", label: `showToolOutput: ${settings.showToolOutput ? "on" : "off"}`, description: "show successful tool result bodies in the transcript" },
		])
		if (!choice) return
		if (choice === "credentials") {
			await showCredentialsSettings(ctx.tui, { refreshAuthCache, onSettingsChanged, setDefaultModel })
			continue
		}
		if (choice === "model") {
			const models = await availableModelEntries(settings)
			if (models.length === 0) {
				write("no authenticated models available; open /settings and choose credentials first")
				continue
			}
			const rows = rowsForModels(models, { currentId: settings.model, scopedModelIds: settings.scopedModelIds })
			const chosen = await pickModel(ctx, rows, { initialSelectedValue: settings.model, title: "Default model", subtitle: "Pick the default model for new sessions." }) ?? ""
			if (!chosen) continue
			const updated = await setDefaultModel?.(chosen) ?? await updateSetting("model", chosen)
			await onSettingsChanged?.(updated)
			write(`default model → ${chosen}`)
			continue
		}
		if (choice === "thinkingLevel") {
			const level = await pickReasoningLevel(ctx.tui, "Default reasoning", "Applied to new sessions")
			if (!level) continue
			const updated = await setDefaultReasoning?.(level) ?? await updateSetting("thinkingLevel", /** @type {any} */ (level))
			await onSettingsChanged?.(updated)
			write(`default reasoning → ${level}`)
			continue
		}
		if (choice === "scopedModelIds") {
			await updateScopedModelsSetting(ctx, settings, write)
			await onSettingsChanged?.(await loadSettings())
			continue
		}
		if (choice === "doubleEscapeAction") {
			const order = ["rewind", "none"]
			const next = order[(order.indexOf(settings.doubleEscapeAction) + 1) % order.length]
			const updated = await updateSetting("doubleEscapeAction", /** @type {any} */ (next))
			await onSettingsChanged?.(updated)
			write(`doubleEscapeAction → ${next}`)
			continue
		}
		if (choice === "web") {
			const next = !settings.web
			const updated = await updateSetting("web", next)
			await onSettingsChanged?.(updated)
			write(`web → ${next ? "on" : "off"}`)
			continue
		}
		if (choice === "showThinkingOutput") {
			const next = !settings.showThinkingOutput
			const updated = await updateSetting("showThinkingOutput", next)
			await onSettingsChanged?.(updated)
			write(`showThinkingOutput → ${next ? "on" : "off"}`)
			continue
		}
		if (choice === "showToolOutput") {
			const next = !settings.showToolOutput
			const updated = await updateSetting("showToolOutput", next)
			await onSettingsChanged?.(updated)
			write(`showToolOutput → ${next ? "on" : "off"}`)
			continue
		}
		if (choice === "autocompactThreshold") {
			const raw = await promptForInput(ctx.tui, `autocompactThreshold (${settings.autocompactThreshold})`)
			if (raw == null) continue
			const parsed = Number(raw.trim())
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
				write(`invalid value: ${raw}`)
				continue
			}
			const updated = await updateSetting("autocompactThreshold", parsed)
			await onSettingsChanged?.(updated)
			write(`autocompactThreshold → ${parsed}`)
		}
	}
}

async function reloadUiSettingsAndAuth({ notify, onSettingsChanged, refreshAuthCache }) {
	const settings = await loadSettings()
	await onSettingsChanged?.(settings)
	await refreshAuthCache?.()
	notify(`reloaded — model=${settings.model} reasoning=${reasoningLevelLabel(settings.thinkingLevel)}`)
}

function openUrlInBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open"
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
	return new Promise((resolve) => {
		let settled = false
		const settle = (opened) => {
			if (settled) return
			settled = true
			resolve(opened)
		}
		try {
			const child = spawn(command, args, { stdio: "ignore", detached: true })
			child.once("error", () => settle(false))
			child.unref?.()
			const timer = setTimeout(() => settle(true), 50)
			timer.unref?.()
		} catch {
			settle(false)
		}
	})
}

function webOpenNotice(url) {
	return hyperlink(theme.cyan("Opened Pinano Web"), url)
}

const THINKING_LEVELS = REASONING_LEVELS
const reasoningLevelItems = () => THINKING_LEVELS.map((level) => ({
	value: level,
	label: level,
	description: {
		default: "use the model/provider default",
		none: "disable reasoning when the model supports it",
		minimal: "very small reasoning budget",
		low: "efficient tool-use and planning",
		medium: "balanced reasoning budget",
		high: "hard reasoning and complex debugging",
		xhigh: "very long rollouts; highest latency/cost",
	}[level] ?? "",
}))

function pickReasoningLevel(tui, title = "Reasoning", subtitle = "Select reasoning effort") {
	return pickFromOverlay(tui, reasoningLevelItems(), {
		title,
		subtitle,
		maxVisible: reasoningLevelItems().length,
		width: "72%",
		maxHeight: "60%",
	})
}

/** @param {any} snapshot */
function agentAdapterForSnapshot(snapshot) {
	return {
		state: {
			model: snapshot?.model ?? { id: "?", provider: "unknown", baseUrl: "", contextWindow: 0 },
			thinkingLevel: reasoningLevelLabel(snapshot?.thinkingLevel),
			messages: snapshot?.contextMessages ?? snapshot?.messages ?? [],
			contextStats: snapshot?.contextStats,
			systemPrompt: snapshot?.systemPrompt ?? "",
			tools: snapshot?.tools ?? [],
		},
	}
}

class SessionInfoLine {
	/** @param {() => any} getSnapshot */
	constructor(getSnapshot) {
		this.getSnapshot = getSnapshot
	}

	/** @param {number} width */
	render(width) {
		const snapshot = this.getSnapshot()
		const cwd = singleLine(snapshot?.cwd) || "?"
		const description = singleLine(snapshot?.agentView?.descriptionInUi ?? snapshot?.agentView?.description)
		const text = description
			? `${theme.cyan(cwd)}${theme.dim(" │ ")}${theme.dim(description)}`
			: theme.cyan(cwd)
		return [truncateToWidth(text, Math.max(1, width), "", true)]
	}
}

export class Chat {
	/**
	 * @param {object} opts
	 * @param {TUI} opts.tui
	 * @param {any} opts.client
	 * @param {string} opts.sessionId
	 * @param {() => void} opts.detach
	 * @param {() => void} opts.exit
	 * @param {StderrCapture} [opts.stderrCapture]
	 * @param {(err: unknown) => boolean} [opts.onClientError]
	 * @param {{ showThinkingOutput: boolean, showToolOutput: boolean }} opts.messageRenderOptions
	 * @param {boolean} [opts.webEnabled]
	 * @param {(settings: import("./settings.js").Settings) => void} [opts.onSettingsChanged]
	 * @param {(payload: import("./codex-usage.js").CodexUsagePayload) => void} [opts.onCodexUsage]
	 * @param {(model: any) => string | undefined} [opts.getCodexUsageBaseUrl]
	 * @param {() => Promise<void>} [opts.refreshGlobalAuth]
	 */
	constructor(opts) {
		this.tui = opts.tui
		this.client = opts.client
		this.sessionId = opts.sessionId
		this.detach = opts.detach
		this.exit = opts.exit
		this.stderrCapture = opts.stderrCapture
		this.onClientError = opts.onClientError
		this.messageRenderOptions = opts.messageRenderOptions
		this.webEnabled = opts.webEnabled === true
		this.onSettingsChanged = opts.onSettingsChanged
		this.onCodexUsage = opts.onCodexUsage
		this.getCodexUsageBaseUrl = opts.getCodexUsageBaseUrl
		this.refreshGlobalAuth = opts.refreshGlobalAuth
		this.disposed = false
		this.promptRequestInFlight = false
		this.interruptRequested = false
		this.abortPromise = undefined
		this.promptCancelPromise = undefined
		this.backgroundMutationRefreshes = new Map()
		this.submittedPromptText = undefined
		this.submittedPromptAttachments = []
		this.draftClientId = randomUUID()
		this.draftClientSeq = 0
		this.draftSyncTimer = undefined
		this.applyingPromptDraft = false
		this.lastPromptDraftVersion = -1
		this.promptImages = []
		this.promptImageCounter = 0
		this.snapshot = null
		this.root = new Container()
		this.chatContainer = new TranscriptContainer()
		this.statusContainer = new Container()
		this.pendingContainer = new Container()
		this.usageStatusLine = new Text("", 0, 0)
		this.editorContainer = new Container()
		this.toolComponents = new Map()
		this.toolCallDetails = new Map()
		this.statusLoader = undefined
		this.statusAgeTimer = undefined
		this.statusProgress = undefined
		this.statusRunStartedAt = undefined
		this.streamingAssistant = undefined
		this.renderedMessageKeys = []
		this.announcedContextPaths = new Set()
		this.needsSnapshotRebuild = false
		this.lastSeq = -1
		this.viewEpoch = undefined
		this.subscriptionProviders = new Set()
		this.footerAgent = agentAdapterForSnapshot(null)
		this.footer = new Footer(
			/** @type {any} */ (this.footerAgent),
			(provider) => this.subscriptionProviders.has(provider),
			() => this.stderrCapture?.size() ?? 0,
		)
		this.sessionInfoLine = new SessionInfoLine(() => this.snapshot)
		this.stderrUnsubscribe = this.stderrCapture?.subscribe(() => {
			this.footer.update()
			this.tui.requestRender()
		})
		this.editor = new Editor(this.tui, /** @type {any} */ (editorTheme), { paddingX: 1 })
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(() => serviceChatCommandsForModel(this.snapshot?.model, { web: this.webEnabled }), process.cwd(), null))
		this.editor.onChange = (text) => {
			if (this.applyingPromptDraft) return
			this.schedulePromptDraftSync(text)
		}
		this.editor.onSubmit = (text) => {
			const trimmed = text.trim()
			if (!trimmed) return
			const commandLine = serviceChatCommandLine(trimmed, { web: this.webEnabled })
			if (commandLine) {
				this.clearPromptImagesForText(trimmed)
				void this.handleSlash(commandLine).catch((err) => this.reportClientError(err, "/cmd error"))
				return
			}
			if (!this.webEnabled && isWebSlashCommand(trimmed)) {
				this.clearPromptImagesForText(trimmed)
				this.appendLine(theme.dim("Pinano Web is disabled; set web: true in settings.json to enable /web."))
				return
			}
			const shortcut = parseBashShortcut(trimmed)
			if (shortcut) {
				this.clearPromptImagesForText(trimmed)
				void this.client.bash(this.sessionId, trimmed).then(async (res) => {
					this.appendLine(theme.dim(`$ ${shortcut.command}${shortcut.excludeFromContext ? " (no-ctx)" : ""}`))
					if (res.result?.output) this.appendLine(res.result.output)
					await this.refreshAfterMutation(res)
				}).catch((err) => this.reportClientError(err, "bash error"))
				return
			}
			const streaming = this.snapshot?.isStreaming
			void this.sendPromptIfConfigured(trimmed, streaming ? "steer" : undefined).catch((err) => this.reportClientError(err, "error"))
		}
		this.root.addChild(this.chatContainer)
		this.root.addChild(this.statusContainer)
		this.root.addChild(this.pendingContainer)
		this.root.addChild(this.usageStatusLine)
		this.root.addChild(new Spacer(1))
		this.root.addChild(new SessionKeyHints(() => ({
			hasText: this.editor.getText().trim() !== "",
			interruptible: this.hasInterruptibleTurn(),
		})))
		this.editorContainer.addChild(this.editor)
		this.root.addChild(this.editorContainer)
		this.root.addChild(this.footer.component)
		this.root.addChild(this.sessionInfoLine)
		void this.refreshAuthCache()
	}

	dispose() {
		this.disposed = true
		this.stopStatusAgeTimer()
		this.hideStatusLoader()
		if (this.draftSyncTimer) clearTimeout(this.draftSyncTimer)
		this.stderrUnsubscribe?.()
	}

	async refreshAuthCache() {
		try {
			this.subscriptionProviders = await loadSubscriptionProviders()
			this.footer.update()
			this.tui.requestRender()
		} catch {}
	}

	reportClientError(err, label) {
		if (this.onClientError?.(err)) return
		this.appendLine(theme.red(`[${label}] ${err?.message ?? err}`))
	}

	nextDraftClientSeq() {
		this.draftClientSeq += 1
		return this.draftClientSeq
	}

	/** @param {string} text @param {{ immediate?: boolean }} [options] */
	schedulePromptDraftSync(text, options = {}) {
		if (!this.client.setPromptDraft) return
		if (this.draftSyncTimer) clearTimeout(this.draftSyncTimer)
		const sync = () => this.syncPromptDraft(text)
		if (options.immediate) sync()
		else this.draftSyncTimer = setTimeout(sync, 150)
	}

	/** @param {string} text */
	syncPromptDraft(text) {
		this.draftSyncTimer = undefined
		const clientSeq = this.nextDraftClientSeq()
		this.client.setPromptDraft(this.sessionId, text, { clientId: this.draftClientId, clientSeq })
			.catch((err) => this.reportClientError(err, "draft sync error"))
	}

	/** @param {any} draft @param {{ force?: boolean }} [options] */
	applyPromptDraft(draft, options = {}) {
		const version = Number(draft?.version ?? 0)
		if (!options.force && version <= this.lastPromptDraftVersion) return
		this.lastPromptDraftVersion = version
		if (!options.force && draft?.updatedByClientId === this.draftClientId) return
		const text = draft?.text ?? ""
		if (this.editor.getText() === text) return
		this.applyingPromptDraft = true
		try {
			this.editor.setText(text)
		} finally {
			this.applyingPromptDraft = false
		}
	}

	restorePromptDraft(text) {
		this.applyingPromptDraft = true
		try {
			this.editor.setText(text)
		} finally {
			this.applyingPromptDraft = false
		}
		this.schedulePromptDraftSync(text, { immediate: true })
	}

	/** @param {string} text @param {"steer" | undefined} [streamingBehavior] */
	async sendPromptIfConfigured(text, streamingBehavior) {
		if (!(await hasAvailableModelProvider())) {
			this.appendSpacer()
			this.appendLine(theme.dim(NO_MODEL_PROVIDER_CHAT_NOTICE))
			this.restorePromptDraft(text)
			this.tui.requestRender()
			return
		}
		this.sendPrompt(text, streamingBehavior)
	}

	/** @param {string} text @param {"steer" | undefined} [streamingBehavior] */
	sendPrompt(text, streamingBehavior) {
		const attachments = this.promptAttachmentsForText(text)
		const images = attachments.map((attachment) => attachment.image)
		this.promptRequestInFlight = true
		if (!streamingBehavior) {
			this.submittedPromptText = text
			this.submittedPromptAttachments = attachments
		}
		if (this.draftSyncTimer) {
			clearTimeout(this.draftSyncTimer)
			this.draftSyncTimer = undefined
		}
		const draftClientSeq = this.nextDraftClientSeq()
		const request = this.client.prompt(this.sessionId, text, streamingBehavior, { draftClientId: this.draftClientId, draftClientSeq, images })
			.then(async (res) => {
				this.clearPromptImagesForText(text)
				await this.refreshAfterMutation(res)
			})
			.catch((err) => {
				this.reportClientError(err, "error")
				this.restorePromptDraft(text)
			})
			.finally(() => {
				this.promptRequestInFlight = false
				if (this.interruptRequested) {
					if (!this.promptCancelPromise) this.requestInterrupt()
					else {
						if (this.snapshot) this.renderStatus(this.snapshot)
						this.tui.requestRender()
					}
					return
				}
				if (this.snapshot) this.renderStatus(this.snapshot)
				this.tui.requestRender()
			})
		request.catch(() => {})
	}

	promptAttachmentsForText(text) {
		return promptAttachmentsForText(this.promptImages, text)
	}

	promptImagesForText(text) {
		return this.promptAttachmentsForText(text).map((attachment) => attachment.image)
	}

	clearPromptImagesForText(text) {
		this.promptImages = clearPromptImageAttachmentsForText(this.promptImages, text)
	}

	clearSubmittedPrompt() {
		this.submittedPromptText = undefined
		this.submittedPromptAttachments = []
	}

	restorePromptImagesForText(text, images = []) {
		const seen = new Set()
		const placeholders = promptImagePlaceholders(text).filter((item) => {
			if (seen.has(item.placeholder)) return false
			seen.add(item.placeholder)
			return true
		})
		if (placeholders.length === 0) return
		const restored = placeholders.flatMap((item, index) => {
			const existing = this.submittedPromptAttachments.find((attachment) => attachment.placeholder === item.placeholder)
				?? this.promptImages.find((attachment) => attachment.placeholder === item.placeholder)
			const image = existing?.image ?? images[index]
			return image ? [{ placeholder: item.placeholder, image }] : []
		})
		this.promptImages = [
			...this.promptImages.filter((attachment) => !placeholders.some((item) => item.placeholder === attachment.placeholder)),
			...restored,
		]
		this.promptImageCounter = Math.max(this.promptImageCounter, ...placeholders.map((item) => item.index))
	}

	insertPromptImage(image) {
		this.promptImageCounter = insertPromptImageAttachment(this.editor, this.promptImages, this.promptImageCounter, image)
		this.tui.requestRender()
	}

	async pasteClipboardImage() {
		try {
			const image = await readClipboardImage()
			this.insertPromptImage(image)
		} catch (err) {
			this.appendLine(theme.red(`[image paste error] ${err?.message ?? err}`))
			this.tui.requestRender()
		}
	}

	hasPromptCancelCandidate() {
		return !!this.submittedPromptText && (this.promptRequestInFlight || this.snapshot?.isStreaming === true)
	}

	hasInterruptibleTurn() {
		return this.interruptRequested || this.promptRequestInFlight || this.snapshot?.isStreaming === true
	}

	requestEscapeInterrupt() {
		if (this.hasPromptCancelCandidate() && this.client.cancelPrompt) return this.requestPromptCancel()
		return this.requestInterrupt()
	}

	requestPromptCancel() {
		this.interruptRequested = true
		this.showStatusLoader("Cancelling prompt…")
		this.tui.requestRender()
		if (this.promptCancelPromise) return this.promptCancelPromise
		const fallbackText = this.submittedPromptText
		const fallbackAttachments = this.submittedPromptAttachments
		this.promptCancelPromise = this.client.cancelPrompt(this.sessionId)
			.then((res) => {
				this.settleInterruptLocally()
				if (res?.cancelled) {
					const text = res.text ?? fallbackText ?? ""
					this.restorePromptImagesForText(text, res.images ?? fallbackAttachments.map((attachment) => attachment.image))
					this.editor.setText(text)
					this.clearSubmittedPrompt()
				} else if (this.snapshot?.isStreaming === false) {
					this.clearSubmittedPrompt()
				}
				this.refreshAfterMutationInBackground(res, { errorLabel: "cancel prompt refresh error" })
			})
			.catch((err) => this.reportClientError(err, "cancel prompt error"))
			.finally(() => {
				this.promptCancelPromise = undefined
				this.interruptRequested = false
				if (this.snapshot) this.renderStatus(this.snapshot)
				else this.hideStatusLoader()
				this.tui.requestRender()
			})
		this.promptCancelPromise.catch(() => {})
		return this.promptCancelPromise
	}

	requestInterrupt() {
		this.interruptRequested = true
		if (this.snapshot) this.renderStatus(this.snapshot)
		else this.showStatusLoader("Interrupting…")
		this.tui.requestRender()
		if (this.abortPromise) return this.abortPromise
		this.abortPromise = this.client.abort(this.sessionId)
			.then((res) => {
				this.settleInterruptLocally()
				this.refreshAfterMutationInBackground(res, { errorLabel: "interrupt refresh error" })
			})
			.catch((err) => this.reportClientError(err, "interrupt error"))
			.finally(() => {
				this.abortPromise = undefined
				if (this.interruptRequested && (this.promptRequestInFlight || this.snapshot?.isStreaming)) {
					this.renderStatus(this.snapshot ?? {})
					this.tui.requestRender()
					return
				}
				this.interruptRequested = false
				if (this.snapshot) this.renderStatus(this.snapshot)
				else this.hideStatusLoader()
				this.tui.requestRender()
			})
		this.abortPromise.catch(() => {})
		return this.abortPromise
	}

	appendLine(text) {
		this.chatContainer.addItem(new TextLine(text), "custom")
		this.tui.requestRender()
	}

	/** @param {{ text: string, tone: "normal" | "warn" | "error" } | undefined} status */
	setCodexUsageStatus(status) {
		this.usageStatusLine.setText(status?.text ? colorUsageStatus(status.text, status.tone) : "")
		this.tui.requestRender()
	}

	appendSpacer() {
		if (this.chatContainer.children.length === 0) return
		this.chatContainer.addSeparator()
		this.tui.requestRender()
	}

	async openWeb() {
		this.appendSpacer()
		const web = await webForOpening(this.client)
		const url = webUrlForRoute(web, sessionRoute(this.sessionId))
		await openUrlInBrowser(url)
		this.appendLine(webOpenNotice(url))
	}

	/** @param {string} text @param {{ label?: string, tone?: "info" | "warn" | "error" }} [options] */
	appendChatNote(text, options = {}) {
		this.chatContainer.addItem(new CustomMessageComponent(text, {
			label: options.label ?? "note",
			tone: options.tone ?? "info",
		}), "custom")
		this.tui.requestRender()
	}

	/** @param {string} text @param {"info" | "warn" | "error"} [tone] */
	appendOverviewNote(text, tone = "info") {
		this.appendChatNote(text, { label: "overview", tone })
	}

	/**
	 * @param {ReadonlyArray<any>} messages
	 * @param {{ reset?: boolean, requestRender?: boolean }} [options]
	 */
	announceContextPaths(messages, options = {}) {
		if (options.reset) this.announcedContextPaths.clear()
		let changed = false
		for (const path of projectContextPathsInMessages(messages)) {
			if (this.announcedContextPaths.has(path)) continue
			this.announcedContextPaths.add(path)
			this.chatContainer.addItem(new ContextLoadComponent({ files: [{ path }] }), "custom")
			changed = true
		}
		if (changed && options.requestRender !== false) this.tui.requestRender()
	}

	async showModal(title, body, opts = {}) {
		await showTextModal(this.tui, title, body, opts)
	}

	showSelector(create, opts = {}) {
		if (opts.fullscreen) {
			let handle
			const done = () => {
				handle?.hide()
				this.tui.setFocus(this.editor)
				this.tui.requestRender()
			}
			const { component } = create(done)
			handle = this.tui.showOverlay(component, {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				row: 0,
				col: 0,
				margin: 0,
			})
			this.tui.setFocus(component)
			this.tui.requestRender()
			return
		}

		const done = () => {
			this.editorContainer.clear()
			this.editorContainer.addChild(this.editor)
			this.tui.setFocus(this.editor)
			this.tui.requestRender()
		}
		const { component, focus } = create(done)
		this.editorContainer.clear()
		this.editorContainer.addChild(component)
		this.tui.setFocus(focus)
		this.tui.requestRender()
	}

	/** @param {string} commandLine */
	async handleSlash(commandLine) {
		const [name, ...rest] = commandLine.trim().split(/\s+/)
		const arg = rest.join(" ").trim()
		if (name === "help") {
			await this.showModal("Commands", commandHelpBody(serviceChatCommandsForModel(this.snapshot?.model, { web: this.webEnabled }), ["", "!cmd / !!cmd  run shell commands"]))
			return
		}
		if (name === "hotkeys") {
			await this.showModal("Hotkeys", [
				"Enter         submit prompt",
				"Shift+Enter   newline in prompt",
				"Ctrl+C        exit this frontend without stopping service sessions",
				"Left          return to agents overview when the editor is empty",
				"Ctrl+G        return to agents overview",
				"Esc           interrupt a running turn",
				"Esc Esc       open the rewind picker",
				"Tab           accept autocomplete suggestion",
			].join("\n"))
			return
		}
		if (name === "web") {
			if (!this.webEnabled) {
				this.appendLine(theme.dim("Pinano Web is disabled; set web: true in settings.json to enable /web."))
				return
			}
			await this.openWeb()
			return
		}
		if (name === "abort") {
			await this.refreshAfterMutation(await this.client.abort(this.sessionId))
			return
		}
		if (name === "continue") {
			try {
				const res = await this.client.continueRun(this.sessionId)
				await this.refreshAfterMutation(res)
			} catch (err) {
				if ((err?.message ?? String(err)) === "Cannot continue: assistant_complete") {
					this.appendLine(theme.dim("nothing to resume; sending 'continue' as a prompt"))
					this.sendPrompt("continue")
					return
				}
				throw err
			}
			return
		}
		if (name === "session") {
			await this.showModal("Session", [
				`id:        ${this.sessionId}`,
				`cwd:       ${this.snapshot?.cwd ?? "?"}`,
				`model:     ${this.snapshot?.model?.id ?? "?"}`,
				`provider:  ${this.snapshot?.model?.provider ?? "?"}`,
				`reasoning: ${reasoningLevelLabel(this.snapshot?.thinkingLevel)}`,
				`fast:      ${this.snapshot?.serviceTier === "priority" && isFastModeEligibleModel(this.snapshot?.model) ? "on" : "off"}`,
				`streaming: ${this.snapshot?.isStreaming ? "yes" : "no"}`,
				`messages:  ${this.snapshot?.messages?.length ?? 0}`,
			].join("\n"))
			return
		}
		if (name === "branch") {
			const sourceSessionId = this.sessionId
			const branched = await this.client.branchSession(sourceSessionId)
			this.sessionId = branched.sessionId
			await this.refreshAfterMutation(branched, { sessionId: branched.sessionId, replace: true })
			this.appendSpacer()
			this.appendLine(theme.dim(`branched into ${branched.sessionId.slice(0, 8)}`))
			this.appendLine(theme.dim(`open previous branch: ${sessionOpenCommand(sourceSessionId)}`))
			return
		}
		if (name === "rewind") {
			if (arg) {
				this.appendLine(theme.dim("use /rewind to choose interactively"))
				return
			}
			const targets = await this.client.rewindTargets(this.sessionId)
			if (targets.length === 0) {
				this.appendLine(theme.dim("no rewind targets or branch tips yet"))
				return
			}
			const initialSelectedId = [...targets].reverse().find((target) => target.onActivePath)?.id
			const chosen = await pickHistoryTarget(this, targets, {
				initialSelectedId,
				title: "Rewind or switch branches",
				subtitle: "Pick a prompt to rewind before, or a branch tip to continue from.",
			})
			if (!chosen) return
			const match = targets.find((target) => target.id === chosen)
			if (!match) {
				this.appendLine(theme.red("rewind target not found"))
				return
			}
			if (match.kind === "leaf") {
				const res = await this.client.rewind(this.sessionId, match.id, { targetKind: "leaf" })
				await this.refreshAfterMutation(res)
				this.appendSpacer()
				this.appendLine(theme.dim(match.active ? "already on that branch tip" : "switched to branch tip"))
				return
			}
			const actionItems = [
				{ value: "conversation", label: "Restore conversation", description: "drop everything after this point — no model call" },
				{ value: "conversation-summary", label: "Restore conversation with branch summary", description: "summarize the discarded branch first" },
			]
			if (match.hasFileCheckpoints) {
				actionItems.push(
					{ value: "files-conversation", label: "Restore files and conversation", description: "also hard-reset edited files to their checkpoint preimages" },
					{ value: "files", label: "Restore files", description: "hard-reset edited files, keep the conversation where it is" },
				)
			}
			const mode = await pickInline(this, actionItems, { title: "What should rewind restore?" }) ?? ""
			if (!mode) return
			const restoreConversation = mode !== "files"
			const restoreFiles = mode === "files" || mode === "files-conversation"
			const rewind = async () => {
				const res = await this.client.rewind(this.sessionId, match.id, {
					summary: mode === "conversation-summary",
					restoreFiles,
					restoreConversation,
				})
				await this.refreshAfterMutation(res)
				return res
			}
			const res = mode === "conversation-summary"
				? await this.withStatusLoader("Summarizing branch…", rewind)
				: await rewind()
			if (restoreConversation) this.editor.setText(res.text ?? "")
			this.appendSpacer()
			const message = restoreConversation
				? `rewound${mode === "conversation-summary" ? " with branch summary" : ""}; prompt restored in editor — edit and press Enter`
				: "restored files"
			this.appendLine(theme.dim(message))
			return
		}
		if (name === "reasoning") {
			if (arg) {
				this.appendLine(theme.dim(`use /reasoning to choose interactively; reasoning=${reasoningLevelLabel(this.snapshot?.thinkingLevel)}`))
				return
			}
			const level = await pickReasoningLevel(this.tui, "Session reasoning", "Applied only to this session") ?? undefined
			if (!level) return
			const res = await this.client.setThinking(this.sessionId, level)
			await this.refreshAfterMutation(res)
			this.appendLine(theme.dim(`session reasoning → ${level}`))
			return
		}
		if (name === "fast") {
			const res = await this.client.setFast(this.sessionId, arg)
			await this.refreshAfterMutation(res)
			if (res.message) this.appendLine(theme.dim(res.message))
			return
		}
		if (name === "compact") {
			const res = await this.withStatusLoader("Compacting…", async () => {
				const compacted = await this.client.compact(this.sessionId)
				await this.refreshAfterMutation(compacted)
				return compacted
			})
			if (res.result?.removedCount === 0) this.appendLine(theme.dim("nothing to compact yet"))
			return
		}
		if (name === "context") {
			const lines = this.client.contextReport
				? await this.client.contextReport(this.sessionId)
				: formatContextReport({
					messages: this.snapshot?.contextMessages ?? this.snapshot?.messages ?? [],
					systemPrompt: this.snapshot?.systemPrompt ?? "",
					tools: this.snapshot?.tools ?? [],
					model: this.snapshot?.model,
				})
			await this.showModal("Context", lines.join("\n"))
			return
		}
		if (name === "system") {
			const lines = this.client.systemReport
				? await this.client.systemReport(this.sessionId)
				: formatSystemReport({
					systemPrompt: this.snapshot?.systemPrompt ?? "",
					tools: this.snapshot?.tools ?? [],
					messages: this.snapshot?.contextMessages ?? this.snapshot?.messages ?? [],
				})
			await this.showModal("System prompt, tools, and project context", lines.join("\n"))
			return
		}
		if (name === "usage") {
			await showCodexUsageModal(this.tui, this.getCodexUsageBaseUrl?.(this.snapshot?.model), (payload) => this.onCodexUsage?.(payload))
			return
		}
		if (name === "settings" && !arg) {
			await showSettingsEditor(this, {
				notify: (message) => this.appendLine(theme.dim(message)),
				onSettingsChanged: (settings) => {
					this.webEnabled = settings.web === true
					this.messageRenderOptions = messageRenderOptionsFromSettings(settings)
					this.onSettingsChanged?.(settings)
					if (this.snapshot) this.update(this.snapshot, { rebuildTranscript: true })
				},
				setDefaultModel: async (model) => (await this.client.setDefaultModel?.(model))?.settings ?? updateSetting("model", model),
				setDefaultReasoning: async (level) => (await this.client.setDefaultReasoning?.(level))?.settings ?? updateSetting("thinkingLevel", /** @type {any} */ (level)),
				refreshAuthCache: () => this.refreshAuthCache(),
			})
			return
		}
		if (name === "reload") {
			await reloadUiSettingsAndAuth({
				notify: (message) => this.appendLine(theme.dim(message)),
				onSettingsChanged: (settings) => {
					this.webEnabled = settings.web === true
					this.messageRenderOptions = messageRenderOptionsFromSettings(settings)
					this.onSettingsChanged?.(settings)
				},
				refreshAuthCache: async () => {
					await this.refreshAuthCache()
					await this.refreshGlobalAuth?.()
				},
			})
			return
		}
		this.appendLine(theme.red(`unknown service-chat command: /${name}`))
	}

	/** @param {any} msg */
	hasRenderedMessage(msg) {
		const key = messageKey(msg)
		return this.renderedMessageKeys.includes(key)
	}

	/**
	 * @param {any} msg
	 * @param {{ requestRender?: boolean, remember?: boolean }} [options]
	 */
	appendMessage(msg, options = {}) {
		if (isProjectContextMessage(msg) || msg.pinanoCompactionMemento || msg.pinanoCompactionSummary) return
		if (msg.role === "user") {
			this.chatContainer.addItem(new UserMessageComponent(msg), "user")
		} else if (msg.role === "contextLoad") {
			this.chatContainer.addItem(new ContextLoadComponent(msg.contextLoad, flattenContent(msg.content)), "custom")
		} else if (msg.role === "assistant") {
			const c = new AssistantMessageComponent(msg, this.messageRenderOptions)
			this.chatContainer.addItem(c, "assistant")
			this.appendToolCallsForMessage(msg)
		} else if (msg.role === "toolResult") {
			const details = msg.toolCallId ? this.toolCallDetails.get(msg.toolCallId) : undefined
			const tc = msg.toolCallId
				? (this.toolComponents.get(msg.toolCallId) ?? this.ensureToolComponent(msg.toolCallId, msg.toolName ?? details?.name, details?.args))
				: undefined
			if (tc) {
				tc.setResult(flattenContent(msg.content), !!msg.isError)
				this.toolComponents.delete(msg.toolCallId)
				this.toolCallDetails.delete(msg.toolCallId)
			} else {
				this.chatContainer.addItem(new CustomMessageComponent(flattenContent(msg.content), {
					label: msg.toolName ?? "tool",
					tone: msg.isError ? "error" : "info",
				}), "custom")
			}
		} else {
			this.chatContainer.addItem(new CustomMessageComponent(flattenContent(msg.content), { label: msg.role }), "custom")
		}
		if (msg.role === "toolResult") this.announceContextPaths([msg], { requestRender: false })
		if (options.remember !== false) this.renderedMessageKeys.push(messageKey(msg))
		if (options.requestRender !== false) this.tui.requestRender()
	}

	/** @param {any} msg */
	upgradeRenderedMessageKey(msg) {
		if (!msg?.entryId || !msg?.messageId) return false
		const provisional = `message:${msg.messageId}`
		const idx = this.renderedMessageKeys.indexOf(provisional)
		if (idx < 0) return false
		this.renderedMessageKeys[idx] = messageKey(msg)
		return true
	}

	/** @param {any} msg */
	appendMessageOnce(msg) {
		if (this.hasRenderedMessage(msg)) return
		if (this.upgradeRenderedMessageKey(msg)) return
		this.appendMessage(msg)
	}

	ensureToolComponent(id, name, args) {
		if (!id) return undefined
		let tc = this.toolComponents.get(id)
		if (tc) {
			if (args !== undefined) tc.updateArgs(args)
			return tc
		}
		tc = new ToolExecutionComponent(name ?? "tool", args ?? {}, this.messageRenderOptions)
		this.toolComponents.set(id, tc)
		this.chatContainer.addItem(tc, "tool")
		return tc
	}

	/** @param {any} msg */
	appendToolCallsForMessage(msg) {
		const blocks = Array.isArray(msg.content) ? msg.content : []
		const toolCalls = blocks.filter((b) => b.type === "toolCall")
		for (const b of toolCalls) this.ensureToolComponent(b.id, b.name, b.input ?? b.arguments)
	}

	/** @param {any} msg */
	startStreamingAssistant(msg) {
		if (isProjectContextMessage(msg)) return
		if (this.streamingAssistant) this.streamingAssistant.update(msg)
		else {
			this.streamingAssistant = new AssistantMessageComponent(msg, this.messageRenderOptions)
			this.chatContainer.addItem(this.streamingAssistant, "assistant")
		}
		this.tui.requestRender()
	}

	/** @param {any} snapshot */
	snapshotMatchesRenderedTranscript(snapshot) {
		const messages = (snapshot.messages ?? []).filter((msg) => !isProjectContextMessage(msg))
		if (messages.length !== this.renderedMessageKeys.length) return false
		for (let i = 0; i < messages.length; i++) {
			if (messageKey(messages[i]) !== this.renderedMessageKeys[i]) return false
		}
		if (snapshot.streamingMessage) {
			return !!this.streamingAssistant?.message && messageKey(this.streamingAssistant.message) === messageKey(snapshot.streamingMessage)
		}
		return !this.streamingAssistant
	}

	/** @param {any} snapshot */
	snapshotShapeMatchesCurrent(snapshot) {
		const current = this.snapshot ?? {}
		const messages = (snapshot.messages ?? []).filter((msg) => !isProjectContextMessage(msg))
		const currentMessages = (current.messages ?? []).filter((msg) => !isProjectContextMessage(msg))
		if (messages.length !== currentMessages.length) return false
		for (let i = 0; i < messages.length; i++) {
			if (messageKey(messages[i]) !== messageKey(currentMessages[i])) return false
		}
		if (!!snapshot.streamingMessage !== !!current.streamingMessage) return false
		if (snapshot.streamingMessage && messageKey(snapshot.streamingMessage) !== messageKey(current.streamingMessage)) return false
		return true
	}

	/** @param {string} message */
	showStatusLoader(message) {
		if (this.statusLoader) {
			this.statusLoader.setMessage(message)
			return
		}
		this.statusContainer.clear()
		this.statusLoader = new Loader(this.tui, theme.cyan, theme.dim, message)
		this.statusContainer.addChild(this.statusLoader)
	}

	hideStatusLoader() {
		if (this.statusLoader) {
			this.statusLoader.stop()
			this.statusLoader = undefined
		}
		this.statusContainer.clear()
	}

	stopStatusAgeTimer() {
		if (!this.statusAgeTimer) return
		clearInterval(this.statusAgeTimer)
		this.statusAgeTimer = undefined
	}

	updateStatusAgeTimer(snapshot) {
		if (snapshot?.isStreaming) {
			if (!this.statusAgeTimer) {
				this.statusAgeTimer = setInterval(() => {
					if (this.snapshot) this.renderStatus(this.snapshot)
				}, 1000)
			}
			return
		}
		this.stopStatusAgeTimer()
	}

	/** @param {any} snapshot */
	ensureStatusRunStart(snapshot) {
		if (!snapshot?.isStreaming) {
			this.statusRunStartedAt = undefined
			return undefined
		}
		if (!this.statusRunStartedAt) this.statusRunStartedAt = new Date().toISOString()
		return this.statusRunStartedAt
	}

	/**
	 * @template T
	 * @param {string} message
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async withStatusLoader(message, fn) {
		this.showStatusLoader(message)
		this.tui.requestRender()
		try {
			return await fn()
		} finally {
			if (this.snapshot) this.renderStatus(this.snapshot)
			else this.hideStatusLoader()
			this.tui.requestRender()
		}
	}

	/** @param {any} snapshot */
	streamingProgressMessage(snapshot) {
		const request = snapshot.currentModelRequest
		const requestKey = request?.startedAt || "no-request"
		const message = snapshot.streamingMessage?.role === "assistant" ? snapshot.streamingMessage : null
		if (!message) {
			this.statusProgress = { requestKey, chars: 0, changedAt: Date.now() }
			return request?.startedAt ? "waiting for stream" : "preparing turn"
		}
		const progress = streamingContentProgress(message)
		const now = Date.now()
		const previous = this.statusProgress
		if (!previous || previous.requestKey !== requestKey || previous.chars !== progress.chars) {
			this.statusProgress = { requestKey, chars: progress.chars, changedAt: now }
		}
		const unchangedMs = now - (this.statusProgress?.changedAt ?? now)
		const parts = [`${formatCount(progress.chars)} chars`]
		if (unchangedMs >= 2000) parts.push(`unchanged ${elapsedDuration(unchangedMs)}`)
		return parts.join(" · ")
	}

	/** @param {any} snapshot */
	streamingStatusMessage(snapshot) {
		const pendingDetails = snapshot.pendingToolCallDetails ?? []
		const pending = pendingDetails.length || snapshot.pendingToolCalls?.length || snapshot.pendingToolCalls?.size || 0
		if (pending) {
			const tools = pendingDetails.map((t) => t.name).filter(Boolean).join(", ")
			return `Running tool${pending === 1 ? "" : "s"}${tools ? `: ${tools}` : ""}…`
		}
		const base = snapshot.streamingMessage?.role === "assistant"
			? streamingStatusBase(snapshot.streamingMessage)
			: "Thinking…"
		const request = snapshot.currentModelRequest
		const age = elapsedAge(request?.startedAt || this.ensureStatusRunStart(snapshot))
		const progress = this.streamingProgressMessage(snapshot)
		return `${base}${age ? ` ${age}` : ""}${progress ? ` · ${progress}` : ""}`
	}

	/** @param {any} snapshot */
	renderPendingUserMessages(snapshot) {
		const pending = (snapshot?.pendingUserMessages ?? [])
			.map((item) => ({ behavior: item?.behavior ?? "steer", message: item?.message ?? item }))
			.filter((item) => item.message?.role === "user")
		this.pendingContainer.clear()
		if (pending.length === 0) return
		const label = pending.length === 1 ? "Pending message" : `${pending.length} pending messages`
		const behaviorLabels = new Set(pending.map((item) => item.behavior))
		const detail = behaviorLabels.size === 1 && behaviorLabels.has("followUp")
			? "queued for after this turn"
			: "queued for the next agent step"
		this.pendingContainer.addChild(new Spacer(1))
		this.pendingContainer.addChild(new TextLine(theme.dim(`${label} — ${detail}`)))
		for (const item of pending) {
			this.pendingContainer.addChild(new Spacer(1))
			this.pendingContainer.addChild(new UserMessageComponent(item.message))
		}
	}

	renderStatus(snapshot) {
		this.updateStatusAgeTimer(snapshot)
		if (this.interruptRequested && (snapshot.isStreaming || this.promptRequestInFlight || this.abortPromise)) {
			this.showStatusLoader("Interrupting…")
		} else if (snapshot.isStreaming) {
			this.showStatusLoader(this.streamingStatusMessage(snapshot))
		} else {
			this.statusProgress = undefined
			this.statusRunStartedAt = undefined
			this.hideStatusLoader()
			// Derive the banner from the *current branch's* tail message rather than session-scoped
			// run records — those don't get reset on branch navigation (rewind/switchBranchTip), so they
			// stay stale across branches. The transcript tail is the source of truth for whether the
			// branch the user is currently looking at ended cleanly.
			const messages = snapshot.messages ?? []
			const last = messages[messages.length - 1]
			let state = null
			if (last?.role === "assistant") {
				if (last.stopReason === "aborted") state = "aborted"
				else if (last.stopReason === "error" || last.errorMessage) state = "failed"
			} else if (last?.role === "toolResult" && last.isError) {
				state = /aborted/i.test(flattenContent(last.content)) ? "aborted" : null
			}
			if (state) {
				this.statusContainer.addChild(new Spacer(1))
				const message = state === "failed"
					? theme.yellow("Last run failed. Use /continue to retry/resume, or type a new message.")
					: theme.dim("Run stopped. Use /continue to resume, or type a new message.")
				this.statusContainer.addChild(new TextLine(message))
			}
		}
	}

	refreshFooter() {
		this.footerAgent.state = agentAdapterForSnapshot(this.snapshot).state
		this.footer.update()
	}

	/**
	 * @param {any} snapshot
	 * @param {{ rebuildTranscript?: boolean }} [options]
	 */
	update(snapshot, options = {}) {
		const next = cloneSessionSnapshot(snapshot)
		const previousSessionId = this.snapshot?.sessionId
		const firstSnapshot = !previousSessionId
		const sessionChanged = !!previousSessionId && !!next.sessionId && next.sessionId !== previousSessionId
		if (sessionChanged) {
			this.lastSeq = -1
			this.viewEpoch = undefined
			this.needsSnapshotRebuild = false
			this.lastPromptDraftVersion = -1
			this.promptImages = []
			this.promptImageCounter = 0
			this.clearSubmittedPrompt()
		}
		const rebuildTranscript = options.rebuildTranscript ?? (sessionChanged || !this.snapshotMatchesRenderedTranscript(next))
		this.snapshot = next
		if (next.promptDraft) this.applyPromptDraft(next.promptDraft, { force: firstSnapshot || sessionChanged })
		if (!next.isStreaming && !this.promptRequestInFlight) this.interruptRequested = false
		if (!next.isStreaming && !this.promptRequestInFlight && !this.promptCancelPromise) this.clearSubmittedPrompt()
		if (typeof next.seq === "number") this.lastSeq = sessionChanged ? next.seq : Math.max(this.lastSeq, next.seq)
		if (next.viewEpoch !== undefined) this.viewEpoch = next.viewEpoch
		if (rebuildTranscript) {
			this.chatContainer.clear()
			this.toolComponents.clear()
			this.toolCallDetails.clear()
			this.announcedContextPaths.clear()
			this.streamingAssistant = undefined
			this.renderedMessageKeys = []
			for (const msg of next.messages ?? []) this.appendMessage(msg, { requestRender: false })
			if (next.streamingMessage?.role === "assistant") this.startStreamingAssistant(next.streamingMessage)
		}
		this.renderStatus(next)
		this.renderPendingUserMessages(next)
		this.refreshFooter()
		this.tui.requestRender()
	}

	/** @param {any} snapshot */
	updateFromEventSnapshot(snapshot) {
		if (typeof snapshot?.seq === "number" && snapshot.seq < this.lastSeq) return
		const rebuildTranscript = this.needsSnapshotRebuild || !this.snapshotShapeMatchesCurrent(snapshot)
		this.needsSnapshotRebuild = false
		this.update(snapshot, { rebuildTranscript })
	}

	async refreshAfterMutation(result = {}, options = {}) {
		const id = this.mutationSnapshotSessionId(result, options)
		if (!id || !this.client.snapshot) {
			if (result?.snapshot) this.updateFromEventSnapshot(result.snapshot)
			return result?.snapshot
		}
		const snapshot = await this.client.snapshot(id)
		if (options.replace === true || snapshot.sessionId !== this.snapshot?.sessionId) this.update(snapshot)
		else this.updateFromEventSnapshot(snapshot)
		return snapshot
	}

	mutationSnapshotSessionId(result = {}, options = {}) {
		return options.sessionId ?? result?.sessionId ?? result?.snapshot?.sessionId ?? this.sessionId
	}

	refreshAfterMutationInBackground(result = {}, options = {}) {
		const id = this.mutationSnapshotSessionId(result, options)
		const sessionIdAtStart = this.sessionId
		if (!id || !this.client.snapshot) {
			if (result?.snapshot && !this.disposed && this.sessionId === sessionIdAtStart) this.updateFromEventSnapshot(result.snapshot)
			return undefined
		}
		const key = `${id}:${options.replace === true ? "replace" : "update"}`
		const promise = this.client.snapshot(id)
			.then((snapshot) => {
				if (this.disposed || this.sessionId !== sessionIdAtStart) return snapshot
				if (options.replace === true || snapshot.sessionId !== this.snapshot?.sessionId) this.update(snapshot)
				else this.updateFromEventSnapshot(snapshot)
				return snapshot
			})
			.catch((err) => {
				if (!this.disposed && this.sessionId === sessionIdAtStart) this.reportClientError(err, options.errorLabel ?? "snapshot refresh error")
			})
			.finally(() => {
				if (this.backgroundMutationRefreshes.get(key) === promise) this.backgroundMutationRefreshes.delete(key)
			})
		this.backgroundMutationRefreshes.set(key, promise)
		promise.catch(() => {})
		return promise
	}

	settleInterruptLocally() {
		if (!this.snapshot) {
			this.hideStatusLoader()
			this.tui.requestRender()
			return
		}
		this.snapshot = cloneSessionSnapshot({
			...this.snapshot,
			isStreaming: false,
			currentModelRequest: undefined,
			pendingToolCalls: [],
			pendingToolCallDetails: [],
			streamingMessage: null,
		})
		this.renderStatus(this.snapshot)
		this.renderPendingUserMessages(this.snapshot)
		this.refreshFooter()
		this.tui.requestRender()
	}

	/** @param {any} event */
	handleEvent(event) {
		if (event.sessionId && event.sessionId !== this.sessionId) return
		if (typeof event.seq === "number" && event.seq <= this.lastSeq) return
		if (this.viewEpoch !== undefined && event.viewEpoch !== undefined && event.viewEpoch < this.viewEpoch) return
		if (this.viewEpoch !== undefined && event.viewEpoch !== undefined && event.viewEpoch > this.viewEpoch) this.needsSnapshotRebuild = true
		this.snapshot = applySessionEvent(this.snapshot, event)
		if (typeof event.seq === "number") this.lastSeq = event.seq
		if (event.viewEpoch !== undefined) this.viewEpoch = event.viewEpoch
		switch (event.type) {
			case "agent_start":
				this.renderStatus(this.snapshot)
				break
			case "message_start":
				if (event.message?.role === "assistant") {
					this.startStreamingAssistant(event.message)
					this.renderStatus(this.snapshot)
				} else if (event.message?.role === "user") this.appendMessageOnce(event.message)
				break
			case "message_update":
				if (event.message?.role === "assistant" && this.streamingAssistant) {
					this.streamingAssistant.update(event.message)
					this.renderStatus(this.snapshot)
					this.tui.requestRender()
				}
				break
			case "message_end":
				if (event.message?.role === "assistant") {
					if (this.streamingAssistant) {
						this.streamingAssistant.update(event.message)
						this.appendToolCallsForMessage(event.message)
						this.streamingAssistant = undefined
						if (!this.hasRenderedMessage(event.message)) this.renderedMessageKeys.push(messageKey(event.message))
						this.tui.requestRender()
					} else this.appendMessageOnce(event.message)
					this.renderStatus(this.snapshot)
				} else if (event.message) this.appendMessageOnce(event.message)
				break
			case "tool_execution_start":
				if (event.toolCallId) this.toolCallDetails.set(event.toolCallId, { name: event.toolName, args: event.args })
				this.renderStatus(this.snapshot)
				break
			case "tool_execution_update":
				if (event.toolCallId) this.toolCallDetails.set(event.toolCallId, { name: event.toolName, args: event.args })
				this.toolComponents.get(event.toolCallId)?.updateArgs(event.args)
				this.renderStatus(this.snapshot)
				break
			case "tool_execution_end": {
				const tc = this.toolComponents.get(event.toolCallId)
				if (tc) tc.setResult(flattenContent(event.result?.content), !!event.isError)
				this.renderStatus(this.snapshot)
				break
			}
			case "context_load":
				if (event.message) this.appendMessageOnce(event.message)
				break
			case "agent_end":
				this.interruptRequested = false
				this.renderStatus(this.snapshot)
				break
			case "model_retry_scheduled":
				this.appendChatNote(`Model request failed; retrying in ${Math.ceil((event.delayMs ?? 0) / 1000)}s (${event.attempt}/${event.maxAttempts}).`, { label: "model", tone: "warn" })
				break
			case "model_retry_exhausted":
				this.appendChatNote(`Model request failed after ${event.maxAttempts} retries.`, { label: "model", tone: "warn" })
				break
			case "prompt_draft_update":
				this.applyPromptDraft(event.draft)
				break
			case "error":
				this.renderStatus(this.snapshot)
				break
			case "compaction":
				this.needsSnapshotRebuild = true
				break
		}
		this.renderPendingUserMessages(this.snapshot)
		this.refreshFooter()
		this.tui.requestRender()
	}
}

/**
 * Run the unified service-backed TUI shell (chat view + agents overview).
 * @param {object} options
 * @param {any} options.client
 * @param {string} options.cwd
 * @param {boolean} [options.noContextFiles]
 * @param {PinanoRoute} [options.initialRoute]
 * @param {StderrCapture} [options.stderrCapture]
 */
export async function runServiceTuiMode(options) {
	const terminal = new ProcessTerminal()
	const tui = new TUI(terminal)
	const root = new Container()
	const editor = new Editor(tui, /** @type {any} */ (editorTheme), { paddingX: 1 })
	let settings = await loadSettings()
	let webEnabled = settings.web === true
	let hasModelProvider = await hasAvailableModelProvider()
	let highlightEmptyCredentialsGuidance = false
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(() => overviewCommands({ web: webEnabled }), options.cwd, null))
	const overviewSpacerLines = 1
	const overviewKeyHintLines = 1
	let promptLabel = /** @type {PromptLabel | undefined} */ (undefined)
	let overviewModelLine = /** @type {OverviewModelLine | undefined} */ (undefined)
	let overviewUsageStatus = /** @type {{ text: string, tone: "normal" | "warn" | "error" } | undefined} */ (undefined)
	const table = new AgentTable({
		cwd: options.cwd,
		getMaxLines: (width) => tui.terminal.rows
			- overviewSpacerLines
			- overviewKeyHintLines
			- (promptLabel?.lineCount() ?? 0)
			- editor.getRenderedLineCount(width)
			- (overviewModelLine?.lineCount() ?? 0),
		getEmptyLines: () => hasModelProvider ? [
			"No sessions yet.",
		] : [
			"No sessions yet.",
			{ text: NO_MODEL_PROVIDER_EMPTY_GUIDANCE, highlight: highlightEmptyCredentialsGuidance },
		],
	})
	let filterMode = false
	let filterBeforeEdit = ""
	let overviewPromptImages = []
	let overviewPromptImageCounter = 0
	promptLabel = new PromptLabel(() => {
		if (filterMode) return "Filter agents:"
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return `Reply to ${selected.id.slice(0, 8)}:`
		if (!hasModelProvider) return "Configure model provider with /credentials:"
		return ""
	})
	overviewModelLine = new OverviewModelLine(() => {
		if (!hasModelProvider || filterMode) return ""
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return ""
		return overviewModelStatusLine(settings, overviewUsageStatus)
	})
	editor.setPlaceholder(() => {
		if (filterMode) return "filter sessions"
		const selected = table.peekSessionId ? table.selected() : undefined
		if (selected && selected.id === table.peekSessionId) return "type to reply"
		if (!hasModelProvider) return ""
		return "type to dispatch new agent session"
	})
	const overviewKeyHints = new OverviewKeyHints(() => ({
		filterMode,
		peeking: Boolean(table.peekSessionId && table.selected()?.id === table.peekSessionId),
		hasText: editor.getText().trim().length > 0,
	}))
	const requestShellRender = (force = false) => {
		editor.invalidate()
		tui.requestRender(force)
	}
	const overviewPromptAttachmentsForText = (text) => promptAttachmentsForText(overviewPromptImages, text)
	const clearOverviewPromptImagesForText = (text) => {
		overviewPromptImages = clearPromptImageAttachmentsForText(overviewPromptImages, text)
	}
	const clearOverviewPromptImages = () => {
		overviewPromptImages = []
	}
	const pasteOverviewClipboardImage = async () => {
		try {
			const image = await readClipboardImage()
			overviewPromptImageCounter = insertPromptImageAttachment(editor, overviewPromptImages, overviewPromptImageCounter, image)
			requestShellRender()
		} catch (err) {
			table.setNotice(`[image paste error] ${err?.message ?? err}`)
			requestShellRender()
		}
	}
	let currentChat = /** @type {Chat | undefined} */ (undefined)
	let currentRoute = options.initialRoute ?? overviewRoute
	let subscriptionProviders = new Set()
	let latestCodexUsage = /** @type {import("./codex-usage.js").CodexUsagePayload | undefined} */ (undefined)
	const codexUsageWarningsSeen = new Set()
	let unsubscribe = /** @type {undefined | (() => void)} */ (undefined)
	let messageRenderOptions = messageRenderOptionsFromSettings(settings)
	const doubleEscape = new DoubleEscapeTracker()
	const textDoubleEscape = new DoubleEscapeTracker()
	let staleRuntimeActive = false
	let staleRuntimeDesired = /** @type {any} */ (null)
	let staleRuntimeRouteArgs = /** @type {string[]} */ ([])
	let reexecInProgress = false
	const staleRuntimeBanner = {
		invalidate() {},
		render(width) {
			const center = (line) => `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(stripAnsi(line))) / 2)))}${line}`
			const innerWidth = Math.max(32, Math.min(68, width - 8))
			const border = "━".repeat(innerWidth + 4)
			const row = (text = "") => {
				const clipped = truncateToWidth(text, innerWidth)
				const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(stripAnsi(clipped))))
				return center(`${theme.red("┃")}  ${clipped}${padding}  ${theme.red("┃")}`)
			}
			return [
				"",
				"",
				center(theme.red(`┏${border}┓`)),
				row(),
				row(theme.red("Pinano was updated.")),
				row(),
				row(reexecInProgress ? theme.cyan("Reopening…") : `${theme.cyan("Enter")} reopen this page`),
				row(`${theme.cyan("Ctrl+C")} exit`),
				row(),
				center(theme.red(`┗${border}┛`)),
				"",
			]
		},
	}
	const currentRouteArgs = () => {
		const args = []
		if (options.noContextFiles) args.push("--no-context-files")
		args.push(...routeToCliArgs(currentRoute))
		return args
	}

	const reexecStaleRuntime = async () => {
		if (reexecInProgress) return
		reexecInProgress = true
		requestShellRender(true)
		await new Promise((resolve) => setTimeout(resolve, 50))
		let tuiStopped = false
		try {
			staleRuntimeDesired = staleRuntimeDesired || await options.client.desiredRuntime?.()
			const runtime = staleRuntimeDesired?.execPath ?? process.execPath
			const target = staleRuntimeDesired?.mainPath
			if (!target) throw new Error("desired runtime path unavailable")
			tui.stop()
			tuiStopped = true
			await reexecRuntime({
				command: runtime,
				args: [target, ...staleRuntimeRouteArgs],
				cwd: options.cwd,
			})
		} catch (err) {
			if (tuiStopped) {
				console.error(`pinano update failed: ${err?.message ?? err}`)
				process.exit(1)
			}
			reexecInProgress = false
			requestShellRender()
		}
	}

	const refreshRows = async () => {
		table.setSessions(await options.client.sessions())
		requestShellRender()
	}
	const refreshRowsAndSelect = async (sessionId) => {
		table.setSessions(await options.client.sessions())
		table.selectSession(sessionId)
		requestShellRender()
	}
	const handleRefreshError = (err) => {
		if (showStaleRuntime(err)) return
		if (isConnectionReset(err)) return
		table.setNotice(`refresh error: ${err?.message ?? err}`)
		requestShellRender()
	}
	const scheduleRowsRefresh = createCoalescedRunner(refreshRows, handleRefreshError)
	const showStaleRuntime = (err) => {
		if (!isStaleRuntimeError(err)) return false
		if (!staleRuntimeActive) {
			staleRuntimeRouteArgs = currentRouteArgs()
			staleRuntimeActive = true
			scheduleRowsRefresh.cancel()
			unsubscribe?.()
			unsubscribe = undefined
			root.addChild(staleRuntimeBanner)
			tui.setFocus(staleRuntimeBanner)
		}
		const desiredRuntimePromise = options.client.desiredRuntime?.()
		if (desiredRuntimePromise) void desiredRuntimePromise
			.then((desired) => {
				if (desired) staleRuntimeDesired = desired
				requestShellRender(true)
			})
			.catch(() => {})
		requestShellRender(true)
		return true
	}

	const clearCodexUsageStatus = () => {
		latestCodexUsage = undefined
		overviewUsageStatus = undefined
		currentChat?.setCodexUsageStatus(undefined)
		requestShellRender()
	}
	const applyCodexUsage = (payload, options = {}) => {
		latestCodexUsage = payload
		const summary = formatCodexUsageInlineSummary(payload)
		overviewUsageStatus = summary ? { text: summary, tone: codexUsageStatusTone(payload) } : undefined
		currentChat?.setCodexUsageStatus(formatCodexUsageLowStatus(payload))
		if (options.emitWarnings && currentChat) {
			for (const message of codexUsageThresholdMessages(payload, codexUsageWarningsSeen)) {
				currentChat.appendChatNote(message.text, { label: "usage", tone: message.tone })
			}
		}
		requestShellRender()
	}
	const refreshCodexUsage = async (usageOptions = {}) => {
		if (!subscriptionProviders.has("openai-codex")) {
			clearCodexUsageStatus()
			return
		}
		const payload = await fetchCodexUsage({ baseUrl: codexUsageBaseUrlForModel(currentChat?.snapshot?.model, settings) })
		applyCodexUsage(payload, { emitWarnings: usageOptions.emitWarnings === true })
	}
	const handleCodexUsageRefreshError = (err) => {
		if (isConnectionReset(err)) return
	}
	const scheduleCodexUsageRefresh = createCoalescedRunner(() => refreshCodexUsage({ emitWarnings: true }), handleCodexUsageRefreshError, 750)

	let exiting = false
	const exit = async () => {
		if (exiting) return
		exiting = true
		scheduleRowsRefresh.cancel()
		scheduleCodexUsageRefresh.cancel()
		currentChat?.dispose()
		if (unsubscribe) {
			let detachTimer
			try {
				await Promise.race([
					unsubscribe(),
					new Promise((resolve) => {
						detachTimer = setTimeout(resolve, 250)
						detachTimer.unref?.()
					}),
				])
			} finally {
				if (detachTimer) clearTimeout(detachTimer)
			}
		}
		tui.stop()
		process.exit(0)
	}

	const mountOverview = () => {
		root.addChild(table)
		root.addChild(new Spacer(1))
		root.addChild(overviewKeyHints)
		root.addChild(promptLabel)
		root.addChild(editor)
		root.addChild(overviewModelLine)
	}

	const showAgents = (showOptions = {}) => {
		currentRoute = overviewRoute
		const selectSessionId = showOptions.selectSessionId ?? currentChat?.sessionId
		currentChat?.dispose()
		currentChat = undefined
		root.clear()
		mountOverview()
		if (selectSessionId) table.selectSession(selectSessionId)
		tui.setFocus(editor)
		requestShellRender(true)
		void (selectSessionId ? refreshRowsAndSelect(selectSessionId) : refreshRows()).catch(handleRefreshError)
	}

	const openSession = async (id) => {
		currentRoute = sessionRoute(id)
		currentChat?.dispose()
		settings = await loadSettings()
		webEnabled = settings.web === true
		messageRenderOptions = messageRenderOptionsFromSettings(settings)
		currentChat = new Chat({ tui, client: options.client, sessionId: id, detach: () => showAgents({ selectSessionId: id }), exit, stderrCapture: options.stderrCapture, onClientError: showStaleRuntime, messageRenderOptions, webEnabled, onSettingsChanged: applyOverviewSettings, onCodexUsage: (payload) => applyCodexUsage(payload), getCodexUsageBaseUrl: (model) => codexUsageBaseUrlForModel(model, settings), refreshGlobalAuth: refreshOverviewAuth })
		root.clear()
		root.addChild(currentChat.root)
		tui.setFocus(currentChat.editor)
		currentChat.update(await options.client.snapshot(id))
		if (latestCodexUsage) currentChat.setCodexUsageStatus(formatCodexUsageLowStatus(latestCodexUsage))
		requestShellRender(true)
	}

	const dispatchNew = async (text, images = []) => {
		hasModelProvider = await hasAvailableModelProvider()
		if (!hasModelProvider) throw new Error(NO_MODEL_PROVIDER_OVERVIEW_ERROR)
		const created = await options.client.createSession()
		table.setActivity(created.sessionId, "queued")
		await refreshRowsAndSelect(created.sessionId)
		void options.client.prompt(created.sessionId, text, undefined, { images })
			.then(() => clearOverviewPromptImagesForText(text))
			.catch((err) => {
				if (showStaleRuntime(err)) return
				table.setActivity(created.sessionId, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
	}

	const applySelectedStateAction = (selected, targetState) => {
		const task = table.stateFor(selected) === targetState
			? options.client.markReadyForReview(selected.id)
			: targetState === "completed"
				? options.client.markCompleted(selected.id)
				: options.client.markDeferred(selected.id)
		task.then(async () => {
			await refreshRows()
		})
			.catch((err) => {
				if (showStaleRuntime(err)) return
				table.setActivity(selected.id, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
	}

	const openWebOverview = async () => {
		const web = await webForOpening(options.client)
		const url = webUrlForRoute(web)
		await openUrlInBrowser(url)
		table.setNotice(webOpenNotice(url))
		requestShellRender()
	}
	const setOverviewNotice = (message) => {
		table.setNotice(message)
		requestShellRender()
	}
	const overviewCommandCtx = {
		tui,
		showSelector(create, opts = {}) {
			if (opts.fullscreen) {
				let handle
				const done = () => {
					handle?.hide()
					tui.setFocus(editor)
					requestShellRender()
				}
				const { component } = create(done)
				handle = tui.showOverlay(component, {
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					row: 0,
					col: 0,
					margin: 0,
				})
				tui.setFocus(component)
				requestShellRender()
				return
			}
			const done = () => showAgents()
			const { component, focus } = create(done)
			root.clear()
			root.addChild(component)
			tui.setFocus(focus)
			requestShellRender()
		},
	}
	const refreshOverviewAuth = async () => {
		subscriptionProviders = await loadSubscriptionProviders()
		hasModelProvider = await hasAvailableModelProvider()
		if (hasModelProvider) highlightEmptyCredentialsGuidance = false
		await currentChat?.refreshAuthCache?.()
		if (!subscriptionProviders.has("openai-codex")) clearCodexUsageStatus()
		else {
			try {
				await refreshCodexUsage()
			} catch {}
		}
		requestShellRender()
	}
	const applyOverviewSettings = (nextSettings) => {
		settings = nextSettings
		webEnabled = nextSettings.web === true
		messageRenderOptions = messageRenderOptionsFromSettings(nextSettings)
		if (currentChat) currentChat.webEnabled = webEnabled
		requestShellRender()
	}
	const setOverviewDefaultModel = async (model) => (await options.client.setDefaultModel?.(model))?.settings ?? updateSetting("model", model)
	const openCredentialsSettingsPage = async (credentialsOptions = {}) => {
		const previousRoute = currentRoute
		currentRoute = settingsCredentialsRoute
		try {
			await showCredentialsSettings(tui, {
				...credentialsOptions,
				loginCodex: options.loginCodex,
				refreshAuthCache: refreshOverviewAuth,
				onSettingsChanged: applyOverviewSettings,
				setDefaultModel: setOverviewDefaultModel,
			})
		} finally {
			if (currentRoute.type === "settings-credentials") currentRoute = currentChat ? sessionRoute(currentChat.sessionId) : previousRoute.type === "settings-credentials" ? overviewRoute : previousRoute
		}
	}
	const selectOverviewModel = async (arg) => {
		let chosen = arg
		if (!chosen) {
			const models = await availableModelEntries(settings)
			if (models.length === 0) {
				setOverviewNotice("no authenticated models available; open /credentials first")
				return
			}
			const rows = rowsForModels(models, {
				currentId: settings.model,
				scopedModelIds: settings.scopedModelIds,
			})
			chosen = await pickModel(overviewCommandCtx, rows, { initialSelectedValue: settings.model, title: "Default model", subtitle: "Pick the default model for new sessions." }) ?? ""
			if (!chosen) return
		}
		const updated = await setOverviewDefaultModel(chosen)
		await applyOverviewSettings(updated)
		setOverviewNotice(`default model → ${chosen}`)
	}
	const handleOverviewCommand = async (commandLine) => {
		const [name, ...rest] = commandLine.trim().split(/\s+/)
		const arg = rest.join(" ").trim()
		if (name === "help") {
			await showTextModal(tui, "Overview commands", commandHelpBody(overviewCommands({ web: webEnabled }), ["", "Type anything else to dispatch a new background agent."]))
			return
		}
		if (name === "hotkeys") {
			await showTextModal(tui, "Overview hotkeys", [
				"Enter/Right   open selected session",
				"Space         peek/reply to selected session",
				"Up/Down       move selection",
				"PgUp/PgDn     move by page",
				"Ctrl+F        filter sessions",
				"Ctrl+V        paste image",
				"Ctrl+D        mark selected session completed",
				"Ctrl+E        mark selected session deferred",
				"Ctrl+X        abort running session or delete idle session",
				"Esc Esc       clear typed text",
				"Ctrl+C        exit this frontend without stopping service sessions",
			].join("\n"))
			return
		}
		if (name === "web") {
			if (!webEnabled) {
				setOverviewNotice("Pinano Web is disabled; set web: true in settings.json to enable /web.")
				return
			}
			await openWebOverview()
			return
		}
		if (name === "usage") {
			await showCodexUsageModal(tui, codexUsageBaseUrlFromSettings(settings), (payload) => applyCodexUsage(payload))
			return
		}
		if (name === "debug-log") {
			await showDebugLogModal(tui, options.stderrCapture, arg)
			requestShellRender()
			return
		}
		if (name === "model") {
			await selectOverviewModel(arg)
			return
		}
		if (name === "credentials") {
			await openCredentialsSettingsPage()
			return
		}
		if (name === "settings" && !arg) {
			await showSettingsEditor(overviewCommandCtx, {
				notify: setOverviewNotice,
				onSettingsChanged: applyOverviewSettings,
				setDefaultModel: setOverviewDefaultModel,
				setDefaultReasoning: async (level) => (await options.client.setDefaultReasoning?.(level))?.settings ?? updateSetting("thinkingLevel", /** @type {any} */ (level)),
				refreshAuthCache: refreshOverviewAuth,
			})
			return
		}
		if (name === "reasoning") {
			if (arg) {
				setOverviewNotice(`use /reasoning to choose interactively; reasoning=${reasoningLevelLabel(settings.thinkingLevel)}`)
				return
			}
			const level = await pickReasoningLevel(tui, "Default reasoning", "Applied to new sessions") ?? undefined
			if (!level) return
			const result = await options.client.setDefaultReasoning?.(level)
			const updated = result?.settings ?? await updateSetting("thinkingLevel", /** @type {any} */ (level))
			await applyOverviewSettings(updated)
			setOverviewNotice(`default reasoning → ${level}`)
			return
		}
		if (name === "reload") {
			await reloadUiSettingsAndAuth({ notify: setOverviewNotice, onSettingsChanged: applyOverviewSettings, refreshAuthCache: refreshOverviewAuth })
			return
		}
	}

	const enterFilterMode = () => {
		clearOverviewPromptImages()
		filterBeforeEdit = table.filter
		filterMode = true
		editor.setText(table.filter)
		requestShellRender()
	}
	const acceptFilterMode = () => {
		filterMode = false
		filterBeforeEdit = table.filter
		editor.setText("")
		requestShellRender()
	}
	const cancelFilterMode = () => {
		filterMode = false
		table.setFilter(filterBeforeEdit)
		editor.setText("")
		requestShellRender()
	}

	editor.onSubmit = (text) => {
		const trimmed = text.trim()
		if (filterMode) {
			table.setFilter(text)
			acceptFilterMode()
			return
		}
		if (!trimmed) return
		const overviewCommand = overviewCommandLine(trimmed, { web: webEnabled })
		if (overviewCommand) {
			clearOverviewPromptImages()
			void handleOverviewCommand(overviewCommand).catch((err) => {
				if (showStaleRuntime(err)) return
				table.setNotice(`/${overviewCommand.trim().split(/\s+/, 1)[0]} error: ${err?.message ?? err}`)
				requestShellRender()
			})
			return
		}
		if (!webEnabled && isWebSlashCommand(trimmed)) {
			clearOverviewPromptImages()
			setOverviewNotice("Pinano Web is disabled; set web: true in settings.json to enable /web.")
			return
		}
		const attachments = overviewPromptAttachmentsForText(trimmed)
		const images = attachments.map((attachment) => attachment.image)
		const selected = table.peekSessionId ? table.selected() : undefined
		const targetId = selected && selected.id === table.peekSessionId ? selected.id : undefined
		if (targetId) {
			void (async () => {
				hasModelProvider = await hasAvailableModelProvider()
				if (!hasModelProvider) throw new Error(NO_MODEL_PROVIDER_OVERVIEW_ERROR)
				const streaming = selected.runStatus === "running"
				await options.client.prompt(targetId, trimmed, streaming ? "steer" : undefined, { images })
				clearOverviewPromptImagesForText(trimmed)
				scheduleRowsRefresh()
			})().catch((err) => {
				if (showStaleRuntime(err)) return
				if (err?.message === NO_MODEL_PROVIDER_OVERVIEW_ERROR) {
					highlightEmptyCredentialsGuidance = table.rows().length === 0
					if (!highlightEmptyCredentialsGuidance) table.setNotice(NO_MODEL_PROVIDER_EMPTY_GUIDANCE)
					editor.setText(trimmed)
				} else table.setActivity(targetId, `error: ${err?.message ?? err}`)
				requestShellRender()
			})
		} else {
			void dispatchNew(trimmed, images).catch((err) => {
				if (showStaleRuntime(err)) return
				if (err?.message === NO_MODEL_PROVIDER_OVERVIEW_ERROR) {
					highlightEmptyCredentialsGuidance = table.rows().length === 0
					if (!highlightEmptyCredentialsGuidance) table.setNotice(NO_MODEL_PROVIDER_EMPTY_GUIDANCE)
				} else table.setNotice(`error: ${err?.message ?? err}`)
				editor.setText(trimmed)
				requestShellRender()
			})
		}
	}
	editor.onChange = (text) => {
		if (filterMode) table.setFilter(text)
		requestShellRender()
	}

	const pendingChatSnapshotRefreshes = new Set()
	const refreshCurrentChatSnapshot = (sessionId) => {
		if (!sessionId || currentChat?.sessionId !== sessionId || pendingChatSnapshotRefreshes.has(sessionId)) return
		pendingChatSnapshotRefreshes.add(sessionId)
		options.client.snapshot(sessionId)
			.then((snapshot) => {
				if (currentChat?.sessionId === sessionId) currentChat.updateFromEventSnapshot(snapshot)
				requestShellRender()
			})
			.catch((err) => {
				if (showStaleRuntime(err)) return
				table.setNotice(`snapshot refresh error: ${err?.message ?? err}`)
				requestShellRender()
			})
			.finally(() => {
				pendingChatSnapshotRefreshes.delete(sessionId)
			})
	}
	const handleServiceEventError = (event, err) => {
		if (showStaleRuntime(err)) return
		const message = err?.message ?? String(err)
		if (event?.sessionId) {
			table.setActivity(event.sessionId, `event error: ${message}`)
			refreshCurrentChatSnapshot(event.sessionId)
		} else table.setNotice(`service event error: ${message}`)
		requestShellRender()
	}
	const handleServiceEvent = (event) => {
		if (event.type === "sessions") table.setSessions(event.sessions)
		else if (event.sessionId) {
			if (event.type === "agent_start") table.setActivity(event.sessionId, "Thinking…")
			else if (event.type === "message_start" && event.message?.role === "assistant") table.setActivity(event.sessionId, "Generating…")
			else if (event.type === "message_update" && event.message?.role === "assistant") {
				const text = flattenContent(event.message.content).trim()
				if (text) table.setActivity(event.sessionId, text.slice(0, 120))
			}
			else if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = flattenContent(event.message.content).trim()
				if (text) table.setActivity(event.sessionId, `result: ${text.slice(0, 110)}`)
			}
			else if (event.type === "tool_execution_start") table.setActivity(event.sessionId, `Running ${event.toolName}…`)
			else if (event.type === "agent_end") {
				const activity = table.activity.get(event.sessionId) || ""
				if (/^(Thinking|Generating|Running)/.test(activity)) table.clearActivity(event.sessionId)
			}
			if (currentChat?.sessionId === event.sessionId) {
				if (event.type === "snapshot" && event.snapshot) currentChat.updateFromEventSnapshot(event.snapshot)
				else {
					if (!eventInvalidatesSessionSnapshot(event, currentChat.sessionId)) currentChat.handleEvent(event)
					if (eventNeedsServiceChatSnapshot(event)) refreshCurrentChatSnapshot(event.sessionId)
				}
			}
			if (event.type === "agent_end" && subscriptionProviders.has("openai-codex")) scheduleCodexUsageRefresh()
			if (eventNeedsServiceSessionRefresh(event)) scheduleRowsRefresh(event.type === "agent_end")
		} else if (eventIsServiceStreamRecovery(event)) {
			if (currentChat?.sessionId) refreshCurrentChatSnapshot(currentChat.sessionId)
			scheduleRowsRefresh(false)
		} else if (event.type === "error") {
			if (showStaleRuntime(event.error)) return
			table.setNotice(`service event error: ${event.error}`)
		}
		requestShellRender()
	}

	unsubscribe = options.client.subscribe((event) => {
		try {
			handleServiceEvent(event)
		} catch (err) {
			handleServiceEventError(event, err)
		}
	})

	tui.addInputListener((data) => {
		if (staleRuntimeActive) {
			if (matchesKey(data, "ctrl+c")) void exit()
			else if (!isKeyRelease(data) && matchesKey(data, "enter")) void reexecStaleRuntime()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+c")) {
			void exit()
			return { consume: true }
		}
		if (tui.hasOverlay()) return undefined
		if (currentChat) {
			if ((matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+alt+v")) && !isKeyRelease(data) && currentChat.editor.focused) {
				void currentChat.pasteClipboardImage()
				return { consume: true }
			}
			if (matchesKey(data, "ctrl+g") && !isKeyRelease(data) && currentChat.editor.focused) {
				showAgents({ selectSessionId: currentChat.sessionId })
				return { consume: true }
			}
			if (matchesKey(data, "left") && currentChat.editor.focused && currentChat.editor.getText().trim() === "") {
				showAgents({ selectSessionId: currentChat.sessionId })
				return { consume: true }
			}
			if (matchesKey(data, "escape")) {
				if (isKeyRelease(data) || !currentChat.editor.focused) return undefined
				if (currentChat.editor.getText().trim() !== "") {
					doubleEscape.reset()
					if (textDoubleEscape.press()) {
						currentChat.clearPromptImagesForText(currentChat.editor.getText())
						currentChat.editor.setText("")
						currentChat.tui.requestRender()
						return { consume: true }
					}
					return undefined
				}
				textDoubleEscape.reset()
				if (currentChat.hasInterruptibleTurn()) {
					doubleEscape.reset()
					currentChat.requestEscapeInterrupt()
					return { consume: true }
				}
				if (doubleEscape.press()) {
					loadSettings()
						.then((settings) => settings.doubleEscapeAction)
						.then((action) => {
							if (action !== "none") return currentChat?.handleSlash("rewind")
						})
						.catch((err) => {
							if (showStaleRuntime(err)) return
							currentChat?.appendLine(theme.red(`[escape error] ${err?.message ?? err}`))
						})
				}
				return { consume: true }
			}
			return undefined
		}
		if (!editor.focused) return undefined
		if (isKeyRelease(data)) return undefined
		if (!filterMode && (matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+alt+v"))) {
			void pasteOverviewClipboardImage()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+f")) {
			if (filterMode) acceptFilterMode()
			else enterFilterMode()
			return { consume: true }
		}
		if (filterMode && matchesKey(data, "enter")) {
			acceptFilterMode()
			return { consume: true }
		}
		if (filterMode && matchesKey(data, "escape")) {
			cancelFilterMode()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "escape") && editor.getText().length > 0 && !editor.isShowingAutocomplete()) {
			clearOverviewPromptImages()
			editor.setText("")
			requestShellRender()
			return { consume: true }
		}
		const empty = editor.getText().trim() === ""
		if (matchesKey(data, "up") && empty) {
			table.move(-1)
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "down") && empty) {
			table.move(1)
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "pageup") && empty) {
			table.page(-1)
			requestShellRender()
			return { consume: true }
		}
		if (matchesKey(data, "pagedown") && empty) {
			table.page(1)
			requestShellRender()
			return { consume: true }
		}
		if (!filterMode && (matchesKey(data, "right") || matchesKey(data, "enter")) && empty) {
			if (table.activateMore()) {
				requestShellRender()
				return { consume: true }
			}
			const selected = table.selected()
			if (selected) openSession(selected.id).catch((err) => {
				if (showStaleRuntime(err)) return
				table.setActivity(selected.id, `error: ${err?.message ?? err}`)
			})
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "space") && empty) {
			if (table.activateMore()) {
				requestShellRender()
				return { consume: true }
			}
			table.togglePeek()
			requestShellRender()
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+e") && empty) {
			const selected = table.selected()
			if (selected) applySelectedStateAction(selected, "deferred")
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+d") && empty) {
			const selected = table.selected()
			if (selected) applySelectedStateAction(selected, "completed")
			return { consume: true }
		}
		if (!filterMode && matchesKey(data, "ctrl+x") && empty) {
			const selected = table.selected()
			if (selected) {
				const task = selected.runStatus === "running"
					? options.client.abort(selected.id)
					: options.client.deleteSession(selected.id)
				task.then(async () => {
					await refreshRows()
				})
					.catch((err) => {
						if (showStaleRuntime(err)) return
						table.setActivity(selected.id, `error: ${err?.message ?? err}`)
						requestShellRender()
					})
			}
			return { consume: true }
		}
		return undefined
	})

	mountOverview()
	tui.addChild(root)
	tui.setFocus(editor)
	tui.start()
	void refreshOverviewAuth().catch(() => {})
	try {
		await refreshRows()
	} catch (err) {
		if (!showStaleRuntime(err)) throw err
	}
	if (currentRoute.type === "session" && !staleRuntimeActive) {
		try {
			await openSession(currentRoute.id)
		} catch (err) {
			if (!showStaleRuntime(err)) throw err
		}
	}
	if (currentRoute.type === "settings-credentials" && !staleRuntimeActive) {
		await openCredentialsSettingsPage()
	} else if (!staleRuntimeActive && !(await hasConfiguredProviderCredentials())) {
		await openCredentialsSettingsPage({ onboarding: true })
	}

	await new Promise(() => {})
}
