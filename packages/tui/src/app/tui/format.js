import { homedir } from "node:os"
import { resolve } from "node:path"

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui/index.js"
import { promptImageLabel, promptImagePlaceholders } from "../../../../protocol/src/prompt-images.js"
import { projectNamesEqual } from "../../../../server/src/app/project-labels.js"
import { theme } from "../theme.js"
export function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/**
 * @param {string} text
 * @param {number} width
 */
export function padToWidth(text, width) {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)))
}

/** @param {string} text */
export function modelLineDivider(text) {
	return theme.dim(text)
}

/**
 * @param {string} text
 * @param {number} width
 */
export function fit(text, width) {
	return padToWidth(truncateToWidth(text, Math.max(1, width)), width)
}

/** @param {string} text @param {"normal" | "warn" | "error"} [tone] */
export function colorUsageStatus(text, tone = "normal") {
	if (tone === "error") return theme.red(text)
	if (tone === "warn") return theme.yellow(text)
	return theme.dim(text)
}

/** @param {unknown} value */
export function singleLine(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
}

/** @param {unknown} value */
export function shortSessionId(value) {
	const text = singleLine(value)
	return text ? text.slice(0, 8) : ""
}

/** @param {string} p */
export function compactHomePath(p) {
	const home = resolve(homedir())
	const path = resolve(p)
	if (path === home) return "~"
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
	return path
}

/** @param {any} value */
export function projectLabel(value) {
	return singleLine(value?.label ?? value)
}

/** @param {any} subject @param {any} associatedProject */
export function explicitProjectOverrideLabel(subject, associatedProject = subject?.project) {
	const explicit = singleLine(subject?.agentView?.projectTag)
	if (!explicit) return ""
	const associated = projectLabel(associatedProject)
	return projectNamesEqual(explicit, associated) ? "" : explicit
}

/** @param {any} subject */
export function effectiveProjectLabel(subject) {
	return explicitProjectOverrideLabel(subject) || projectLabel(subject?.project)
}

export function promptAttachmentsForText(promptImages, text) {
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

export function clearPromptImageAttachmentsForText(promptImages, text) {
	return promptImages.filter((attachment) => !text.includes(attachment.placeholder))
}

/** @param {any} session */
export function sessionRowIsRunning(session) {
	return session.lifecycleState === "running" || session.runStatus === "running" || session.runtimeState === "running"
}

/** @param {any} session */
export function sessionRowCanStillBeQueued(session) {
	if (sessionRowIsRunning(session)) return false
	if (session.lifecycleState && session.lifecycleState !== "not_started") return false
	if (session.runStatus && session.runStatus !== "idle") return false
	if (session.runtimeState && session.runtimeState !== "idle") return false
	return !session.agentView && !session.preview?.first && !session.preview?.lastUser
}

export function insertPromptImageAttachment(editor, promptImages, promptImageCounter, image) {
	const placeholder = promptImageLabel(promptImageCounter + 1)
	promptImages.push({ placeholder, image })
	const current = editor.getText()
	const prefix = current && !/\s$/.test(current) ? " " : ""
	editor.insertTextAtCursor(`${prefix}${placeholder}`)
	return promptImageCounter + 1
}

/** @param {string} text @param {number} width */
export function truncateLeftToWidth(text, width) {
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

/** @param {string} left @param {string} right @param {number} width @param {(text: string) => string} [renderRight] */
export function leftRightLine(left, right, width, renderRight = theme.dim) {
	if (!right) return fit(left, width)
	const minGap = 2
	const rightWidth = width - visibleWidth(left) - minGap
	if (rightWidth <= 0) return fit(left, width)
	const clippedRight = truncateLeftToWidth(right, rightWidth)
	const coloredRight = renderRight(clippedRight)
	const gap = " ".repeat(Math.max(minGap, width - visibleWidth(left) - visibleWidth(coloredRight)))
	return `${left}${gap}${coloredRight}`
}

/**
 * @typedef {object} KeyHintAction
 * @property {string} id
 * @property {string} [role]
 * @property {string} [label]
 * @property {any} [metadata]
 * @property {(event: any) => any} onClick
 */

/** @param {Array<[string, string, KeyHintAction?]>} hints @param {number} width @param {any} [component] */
export function renderKeyHintsFrame(hints, width, component = undefined) {
	let line = ""
	let col = 0
	/** @type {import("../tui/render-frame.js").RenderSpan[]} */
	const spans = []
	hints.forEach(([key, label, action], index) => {
		if (index > 0) {
			const separator = theme.dim(" · ")
			line += separator
			col += visibleWidth(separator)
		}
		const text = label ? `${theme.cyan(key)} ${theme.dim(label)}` : theme.cyan(key)
		const startCol = col
		line += text
		col += visibleWidth(text)
		const endCol = col
		if (action && startCol < width) {
			spans.push({
				line: 0,
				startCol,
				endCol: Math.min(endCol, width),
				component,
				id: action.id,
				role: action.role ?? "button",
				label: action.label,
				metadata: action.metadata,
				onClick: action.onClick,
			})
		}
	})
	return {
		lines: [fit(line, width)],
		spans: spans.filter((span) => span.endCol > span.startCol),
	}
}

/** @param {Array<[string, string, KeyHintAction?]>} hints @param {number} width */
export function renderKeyHints(hints, width) {
	return renderKeyHintsFrame(hints, width).lines
}
