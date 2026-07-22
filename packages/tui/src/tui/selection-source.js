import { getSegmenter, isPunctuationChar, isWhitespaceChar, sanitizeRenderableText, extractAnsiCode } from "./utils.js"

let nextSourceId = 1

/**
 * @typedef {"word" | "line" | "paragraph" | "block" | "message"} SelectionSourceUnit
 * @typedef {{ start: number, end: number }} SelectionSourceRange
 */

/**
 * Plain text source used by rendered source spans. Components own instances of
 * this class and update the text they consider semantic copy content.
 */
export class TextSelectionSource {
	/** @type {string} */
	id
	/** @type {string} */
	text

	/**
	 * @param {string} text
	 * @param {{ id?: string }} [options]
	 */
	constructor(text = "", options = {}) {
		this.id = options.id ?? `selection-source-${nextSourceId++}`
		this.text = text
	}

	/** @param {string} text */
	setText(text) {
		this.text = text
	}

	/** @param {SelectionSourceRange} range */
	textForRange(range) {
		const normalized = normalizeSourceRange(range, this.text.length)
		return this.text.slice(normalized.start, normalized.end)
	}

	/**
	 * @param {number} offset
	 * @param {SelectionSourceUnit} unit
	 * @returns {SelectionSourceRange | null}
	 */
	rangeForUnit(offset, unit) {
		return sourceRangeForUnit(this.text, offset, unit)
	}
}

/**
 * Convert terminal-renderable text into semantic copy text. This strips SGR and
 * OSC controls, keeps meaningful newlines, and mirrors the renderer's tab
 * expansion so source offsets line up with visible cells.
 * @param {string} text
 * @returns {string}
 */
export function semanticTextFromRenderable(text) {
	const sanitized = sanitizeRenderableText(String(text ?? ""), { preserveLineBreaks: true })
	let out = ""
	for (let i = 0; i < sanitized.length;) {
		const ansi = extractAnsiCode(sanitized, i)
		if (ansi) {
			i += ansi.length
			continue
		}
		out += sanitized[i]
		i++
	}
	return out
}

/**
 * @param {SelectionSourceRange} range
 * @param {number} length
 * @returns {SelectionSourceRange}
 */
export function normalizeSourceRange(range, length) {
	const max = Math.max(0, Math.floor(length))
	const start = Number.isFinite(range?.start) ? Math.max(0, Math.min(max, Math.floor(range.start))) : 0
	const end = Number.isFinite(range?.end) ? Math.max(0, Math.min(max, Math.floor(range.end))) : start
	return start <= end ? { start, end } : { start: end, end: start }
}

/**
 * @param {string} text
 * @param {number} offset
 * @param {SelectionSourceUnit} unit
 * @returns {SelectionSourceRange | null}
 */
export function sourceRangeForUnit(text, offset, unit) {
	const point = clampOffsetToText(text, offset)
	switch (unit) {
		case "word":
			return wordRangeAtOffset(text, point)
		case "line":
			return lineRangeAtOffset(text, point)
		case "paragraph":
			return paragraphRangeAtOffset(text, point)
		case "block":
		case "message":
			return text.length > 0 ? { start: 0, end: text.length } : null
		default:
			return null
	}
}

/**
 * @param {string} text
 * @param {number} offset
 */
function clampOffsetToText(text, offset) {
	if (!Number.isFinite(offset)) return 0
	return Math.max(0, Math.min(text.length, Math.floor(offset)))
}

/**
 * @param {string} text
 * @returns {Array<{ start: number, end: number, kind: "word" | "punctuation" | "space" }>}
 */
function sourceUnits(text) {
	/** @type {Array<{ start: number, end: number, kind: "word" | "punctuation" | "space" }>} */
	const units = []
	let offset = 0
	for (const { segment } of getSegmenter().segment(text)) {
		const next = offset + segment.length
		const kind = isWhitespaceChar(segment)
			? "space"
			: isPunctuationChar(segment)
				? "punctuation"
				: "word"
		units.push({ start: offset, end: next, kind })
		offset = next
	}
	return units
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {SelectionSourceRange | null}
 */
function wordRangeAtOffset(text, offset) {
	const units = sourceUnits(text)
	const hitIndex = units.findIndex((unit) => offset >= unit.start && offset < unit.end)
	if (hitIndex === -1) return null
	const hit = units[hitIndex]
	if (hit.kind === "space") return null

	let startIndex = hitIndex
	while (startIndex > 0 && units[startIndex - 1].kind === hit.kind) startIndex--
	let endIndex = hitIndex
	while (endIndex + 1 < units.length && units[endIndex + 1].kind === hit.kind) endIndex++
	return { start: units[startIndex].start, end: units[endIndex].end }
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {SelectionSourceRange | null}
 */
function lineRangeAtOffset(text, offset) {
	if (text.length === 0) return null
	const point = offset === text.length && offset > 0 ? offset - 1 : offset
	const start = text.lastIndexOf("\n", point - 1) + 1
	const nextNewline = text.indexOf("\n", point)
	const end = nextNewline === -1 ? text.length : nextNewline
	return { start, end }
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {SelectionSourceRange | null}
 */
function paragraphRangeAtOffset(text, offset) {
	const line = lineRangeAtOffset(text, offset)
	if (!line) return null
	let start = line.start
	let end = line.end

	while (start > 0) {
		const previousEnd = start - 1
		const previousStart = text.lastIndexOf("\n", previousEnd - 1) + 1
		if (text.slice(previousStart, previousEnd).trim() === "") break
		start = previousStart
	}

	while (end < text.length) {
		const nextStart = end + 1
		const nextEndRaw = text.indexOf("\n", nextStart)
		const nextEnd = nextEndRaw === -1 ? text.length : nextEndRaw
		if (text.slice(nextStart, nextEnd).trim() === "") break
		end = nextEnd
	}

	return { start, end }
}
