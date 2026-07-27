import { isPromptImageMarkerText } from "../../../../../protocol/src/prompt-images.js"
import { isProjectContextMessage } from "../../project/context.js"
import { projectMaintenanceMessage } from "../context.js"

/**
 * @param {any} message
 * @param {{ retainedMaintenanceToolCallIds?: Set<string>, showAutomatedMaintenanceUsers?: boolean }} [options]
 */
export function projectVisibleMessage(message, options = {}) {
	if (!message || message.hidden || isProjectContextMessage(message) || message.compactionMemento || message.compactionSummary) return undefined
	if (!message.automated && !message.maintenance) return message
	if (options.showAutomatedMaintenanceUsers === true && message.role === "user") {
		const projected = { ...message, maintenanceAudit: true }
		delete projected.automated
		delete projected.maintenance
		return projected
	}
	const projected = projectMaintenanceMessage(message, options)
	if (!projected) return undefined
	return projected.role === "assistant" ? { ...projected, maintenanceAudit: true } : projected
}

/** @param {any} message */
export function visibleMessage(message) {
	return projectVisibleMessage(message) !== undefined
}

function isSessionMaintenanceToolName(name) {
	return name === "bash" || name === "exec_command" || name === "exec"
}

export function sessionMaintenanceToolAvailable(tools = []) {
	return tools.some((tool) => isSessionMaintenanceToolName(tool?.name))
}

/** @param {any[]} messages */
export function visibleMessages(messages) {
	const retainedMaintenanceToolCallIds = new Set()
	const projection = { retainedMaintenanceToolCallIds }
	return messages.map((message) => projectVisibleMessage(message, projection)).filter(Boolean)
}

/**
 * @param {Array<{ message: any, entryId: string }>} entries
 * @param {{ showAutomatedMaintenanceUsers?: boolean }} [options]
 */
export function projectVisibleEntries(entries, options = {}) {
	const retainedMaintenanceToolCallIds = new Set()
	const projection = { retainedMaintenanceToolCallIds, showAutomatedMaintenanceUsers: options.showAutomatedMaintenanceUsers === true }
	return entries.flatMap((entry) => {
		const message = projectVisibleMessage(entry.message, projection)
		return message ? [{ ...entry, message }] : []
	})
}

function tsvCell(value) {
	return String(value ?? "").replace(/[\t\r\n]+/g, " ")
}

function transcriptTextLines(value) {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.filter((line) => line.trim() !== "")
}

function stableJsonText(value) {
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value ?? {})
	} catch {
		return String(value ?? "")
	}
}

/** @typedef {{ includeToolDetails?: boolean, entryRange?: { from: number, to: number }, showAutomatedMaintenanceUsers?: boolean }} TranscriptExportOptions */

function toolCallText(block) {
	const payload = Object.prototype.hasOwnProperty.call(block ?? {}, "input") ? block.input : block?.arguments
	return stableJsonText(payload)
}

function transcriptPartsForMessage(message, options = {}) {
	const role = message?.role || "message"
	const baseKind = role === "toolResult" && message.toolName ? `toolResult:${message.toolName}` : role
	if (role === "toolResult" && options.includeToolDetails !== true) {
		return [{ hiddenTool: { type: "result", error: Boolean(message.isError) } }]
	}
	if (typeof message?.content === "string") return [{ kind: baseKind, text: message.content }]
	if (!Array.isArray(message?.content)) return []
	return message.content.flatMap((block) => {
		if (block?.type === "text") return [{ kind: baseKind, text: block.text ?? "" }]
		if (block?.type === "toolCall") {
			const kind = `toolCall:${block.name || "unknown"}`
			if (options.includeToolDetails === true) return [{ kind, text: toolCallText(block) }]
			return [{ hiddenTool: { type: "call" } }]
		}
		if (block?.type === "image") return [{ kind: `${role}:image`, text: `[image ${block.mimeType || "application/octet-stream"}]` }]
		return []
	})
}

function countLabel(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`
}

function hiddenToolSummaryText(summary) {
	const counts = []
	if (summary.calls > 0) counts.push(countLabel(summary.calls, "tool call"))
	if (summary.results > 0) counts.push(countLabel(summary.results, summary.calls > 0 ? "result" : "tool result"))
	const activity = counts.join(" and ")
	const errors = summary.errors > 0 ? `, including ${countLabel(summary.errors, "error")}` : ""
	const selector = summary.from === summary.to ? `entry ${summary.from}` : `entries ${summary.from}:${summary.to}`
	return `[${activity} hidden${errors}; inspect ${selector} with --full]`
}

export function formatTranscriptEntries(sessionId, entries, options = {}) {
	const lines = []
	let hiddenTools
	const appendLine = (sequence, timestamp, kind, text) => lines.push([
		sessionId,
		sequence,
		timestamp ?? "",
		kind,
		text,
	].map(tsvCell).join("\t"))
	const flushHiddenTools = () => {
		if (!hiddenTools) return
		appendLine(hiddenTools.from, hiddenTools.timestamp, "tools", hiddenToolSummaryText(hiddenTools))
		hiddenTools = undefined
	}
	const visibleEntries = projectVisibleEntries(entries, options)
	const numberedEntries = visibleEntries.map((entry, index) => ({ ...entry, sequence: entry.sequence ?? index + 1 }))
	const selectedEntries = options.entryRange
		? numberedEntries.filter((entry) => entry.sequence >= options.entryRange.from && entry.sequence <= options.entryRange.to)
		: numberedEntries
	for (const entry of selectedEntries) {
		for (const part of transcriptPartsForMessage(entry.message, options)) {
			if (part.hiddenTool) {
				hiddenTools ??= {
					from: entry.sequence,
					to: entry.sequence,
					timestamp: entry.message?.timestamp,
					calls: 0,
					results: 0,
					errors: 0,
				}
				hiddenTools.to = entry.sequence
				hiddenTools.calls += part.hiddenTool.type === "call" ? 1 : 0
				hiddenTools.results += part.hiddenTool.type === "result" ? 1 : 0
				hiddenTools.errors += part.hiddenTool.error ? 1 : 0
				continue
			}
			const textLines = transcriptTextLines(part.text)
			if (textLines.length === 0) continue
			flushHiddenTools()
			for (const text of textLines) {
				appendLine(entry.sequence, entry.message?.timestamp, part.kind, text)
			}
		}
	}
	flushHiddenTools()
	return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export function transcriptOptionsForPayload(payload) {
	const rawRange = payload?.entries
	let entryRange
	if (rawRange !== undefined) {
		const from = rawRange?.from
		const to = rawRange?.to
		if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < from) {
			throw Object.assign(new Error("entries must be a valid positive sequence or inclusive range"), { status: 400 })
		}
		entryRange = { from, to }
	}
	return {
		includeToolDetails: payload?.full === true,
		...(entryRange ? { entryRange } : {}),
	}
}

export function sessionCollectionState(session) {
	if (session?.lifecycleState === "running" || session?.runStatus === "running" || session?.runtimeState === "running") return "running"
	return session?.agentView?.state ?? session?.agentViewFallbackState ?? session?.lifecycleState ?? session?.runtimeState ?? session?.runStatus ?? ""
}

function normalizeSessionCollectionState(value) {
	const state = String(value ?? "").trim()
	if (!state) throw Object.assign(new Error("state filter must not be empty"), { status: 400 })
	if (state === "ready-for-review" || state === "ready_for_review" || state === "readyForReview") return "ready_for_review"
	if (state === "needs-input" || state === "needs_input") return "needs_input"
	if (state === "completed" || state === "deferred" || state === "running" || state === "stopped" || state === "not_started") return state
	throw Object.assign(new Error("state filter must be one of ready-for-review, completed, deferred, running, stopped, not_started"), { status: 400 })
}

function parseSinceMillis(value) {
	if (value === undefined || value === null || value === "") return undefined
	const text = String(value).trim()
	const duration = text.match(/^([1-9][0-9]*)([smhdw])$/i)
	if (duration) {
		const n = Number(duration[1])
		const unitMs = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 }[duration[2].toLowerCase()]
		return Date.now() - n * unitMs
	}
	const parsed = Date.parse(text)
	if (!Number.isFinite(parsed)) throw Object.assign(new Error("since filter must be an ISO timestamp or duration like 24h, 7d, 30m"), { status: 400 })
	return parsed
}

function normalizeSessionCollectionFilters(filters = {}) {
	if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw Object.assign(new Error("session filters must be an object"), { status: 400 })
	const limit = filters.limit === undefined ? undefined : Number(filters.limit)
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw Object.assign(new Error("limit filter must be a positive integer"), { status: 400 })
	return {
		...(filters.state !== undefined ? { state: normalizeSessionCollectionState(filters.state) } : {}),
		...(filters.since !== undefined ? { sinceMs: parseSinceMillis(filters.since) } : {}),
		...(limit !== undefined ? { limit } : {}),
	}
}

export function filterSessionCollectionRows(rows, filters = {}) {
	const normalized = normalizeSessionCollectionFilters(filters)
	const filtered = rows
		.filter((session) => normalized.state === undefined || sessionCollectionState(session) === normalized.state)
		.filter((session) => normalized.sinceMs === undefined || Date.parse(session.updatedAt ?? "") >= normalized.sinceMs)
	return normalized.limit === undefined ? filtered : filtered.slice(0, normalized.limit)
}

export function formatSessionCollectionRows(rows) {
	const lines = rows.map((session) => [
		session.id,
		sessionCollectionState(session),
		session.updatedAt ?? "",
		session.project?.label ?? session.agentView?.projectTag ?? "",
		session.cwd ?? "",
		session.agentView?.descriptionInUi ?? session.agentView?.description ?? "",
	].map(tsvCell).join("\t"))
	return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

/** @param {unknown} content */
export function textFromContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return /** @type {any[]} */ (content)
		.filter((block) => block?.type === "text")
		.filter((block) => !isPromptImageMarkerText(block.text ?? ""))
		.map((block) => block.text || "")
		.join("")
}

/** @param {unknown} content */
export function imageBlocksFromContent(content) {
	if (!Array.isArray(content)) return []
	return /** @type {any[]} */ (content)
		.filter((block) => block?.type === "image")
		.map((block) => ({ ...block }))
}
