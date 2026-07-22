import { isImageLine } from "./terminal-image.js"
import { clipSourceSpanColumns, normalizeRegions, normalizeSourceSpans, normalizeSpans } from "./render-frame.js"
import { extractAnsiCode, getSegmenter, isPunctuationChar, isWhitespaceChar, sliceByColumn, visibleWidth } from "./utils.js"

/**
 * @typedef {{ line: number, col: number }} ScreenPoint
 * @typedef {{ start: ScreenPoint, end: ScreenPoint }} ScreenRange
 * @typedef {import("./render-frame.js").RenderSpan} RenderSpan
 * @typedef {import("./render-frame.js").RenderSourceSpan} RenderSourceSpan
 * @typedef {import("./render-frame.js").RenderRegion} RenderRegion
 * @typedef {"word" | "punctuation" | "space"} SelectionUnitKind
 * @typedef {{ startCol: number, endCol: number, kind: SelectionUnitKind }} SelectionUnit
 */

/**
 * Final renderer-owned terminal screen geometry. It stores the unhighlighted
 * rendered rows plus optional span metadata in the same coordinate space, so
 * selection, copy, and app-owned cell hit testing agree on the visible screen.
 */
export class ScreenMap {
	/** @type {string[]} */
	lines
	/** @type {RenderSpan[]} */
	spans
	/** @type {RenderSourceSpan[]} */
	sourceSpans
	/** @type {RenderRegion[]} */
	regions
	height
	viewportTop

	/**
	 * @param {string[]} lines Final unhighlighted rendered rows.
	 * @param {{ height: number, viewportTop?: number, spans?: RenderSpan[], sourceSpans?: RenderSourceSpan[], regions?: RenderRegion[] }} options
	 */
	constructor(lines, options) {
		this.lines = lines
		this.spans = normalizeSpans(options.spans ?? [])
		this.sourceSpans = normalizeSourceSpans(options.sourceSpans ?? [])
		this.regions = normalizeRegions(options.regions ?? [])
		this.height = normalizePositiveInteger(options.height)
		const defaultViewportTop = viewportTopForLines(lines, this.height)
		this.viewportTop = options.viewportTop === undefined
			? defaultViewportTop
			: Math.min(normalizePositiveInteger(options.viewportTop), defaultViewportTop)
	}

	/** @param {number} [height] */
	static empty(height = 0) {
		return new ScreenMap([], { height })
	}

	/**
	 * @param {string[]} lines
	 * @param {{ height: number, viewportTop?: number, spans?: RenderSpan[], sourceSpans?: RenderSourceSpan[], regions?: RenderRegion[] }} options
	 */
	static fromLines(lines, options) {
		return new ScreenMap(lines, options)
	}

	get visibleFirst() {
		return this.viewportTop
	}

	get visibleLast() {
		return Math.min(this.lines.length, this.viewportTop + this.height) - 1
	}

	/** @param {string[]} lines */
	hasSameLines(lines) {
		if (this.lines.length !== lines.length) return false
		return this.lines.every((line, index) => line === lines[index])
	}

	/**
	 * Hit-test 1-based terminal-cell coordinates into the final rendered row buffer.
	 * @param {number} row 1-based terminal row
	 * @param {number} col 1-based terminal column
	 * @param {{ clampRows?: boolean }} [options]
	 * @returns {ScreenPoint | null}
	 */
	hitTest(row, col, options = {}) {
		if (this.lines.length === 0 || this.height <= 0) return null
		const visibleFirst = this.visibleFirst
		const visibleLast = this.visibleLast
		if (visibleLast < visibleFirst) return null

		const rawScreenRow = Math.floor(row) - 1
		const screenRow = options.clampRows
			? Math.max(0, Math.min(this.height - 1, rawScreenRow))
			: rawScreenRow
		if (screenRow < 0 || screenRow >= this.height) return null

		const rawLineIndex = this.viewportTop + screenRow
		const lineIndex = options.clampRows
			? Math.max(visibleFirst, Math.min(visibleLast, rawLineIndex))
			: rawLineIndex
		if (lineIndex < visibleFirst || lineIndex > visibleLast) return null

		const lineWidth = this.selectableLineWidth(lineIndex)
		const localCol = Math.max(0, Math.min(lineWidth, Math.floor(col) - 1))
		return { line: lineIndex, col: localCol }
	}

	/**
	 * Hit-test 1-based terminal-cell coordinates without clamping the column.
	 * This is used for span/event hit testing so clicks in right-side padding do
	 * not resolve to the last rendered cell.
	 * @param {number} row 1-based terminal row
	 * @param {number} col 1-based terminal column
	 * @param {{ clampRows?: boolean }} [options]
	 * @returns {ScreenPoint | null}
	 */
	hitTestCell(row, col, options = {}) {
		if (this.lines.length === 0 || this.height <= 0) return null
		const visibleFirst = this.visibleFirst
		const visibleLast = this.visibleLast
		if (visibleLast < visibleFirst) return null

		const rawScreenRow = Math.floor(row) - 1
		const screenRow = options.clampRows
			? Math.max(0, Math.min(this.height - 1, rawScreenRow))
			: rawScreenRow
		if (screenRow < 0 || screenRow >= this.height) return null

		const rawLineIndex = this.viewportTop + screenRow
		const lineIndex = options.clampRows
			? Math.max(visibleFirst, Math.min(visibleLast, rawLineIndex))
			: rawLineIndex
		if (lineIndex < visibleFirst || lineIndex > visibleLast) return null

		const localCol = Math.floor(col) - 1
		if (localCol < 0) return null
		return { line: lineIndex, col: localCol }
	}

	/**
	 * @param {ScreenPoint} point
	 * @returns {RenderSpan | null}
	 */
	spanAtPoint(point) {
		for (let i = this.spans.length - 1; i >= 0; i--) {
			const span = this.spans[i]
			if (span.line === point.line && point.col >= span.startCol && point.col < span.endCol) return span
		}
		return null
	}

	/**
	 * @param {number} row 1-based terminal row
	 * @param {number} col 1-based terminal column
	 * @returns {RenderSpan | null}
	 */
	spanAt(row, col) {
		const point = this.hitTestCell(row, col)
		return point ? this.spanAtPoint(point) : null
	}

	/**
	 * @param {ScreenPoint} point
	 * @returns {RenderSourceSpan | null}
	 */
	sourceSpanAtPoint(point) {
		for (let i = this.sourceSpans.length - 1; i >= 0; i--) {
			const span = this.sourceSpans[i]
			if (span.line === point.line && point.col >= span.startCol && point.col < span.endCol) return span
		}
		return null
	}

	/**
	 * @param {ScreenPoint} point
	 * @returns {RenderRegion | null}
	 */
	regionAtPoint(point) {
		for (let i = this.regions.length - 1; i >= 0; i--) {
			const region = this.regions[i]
			if (region.line === point.line && point.col >= region.startCol && point.col < region.endCol) return region
		}
		return null
	}

	/**
	 * @param {number} row 1-based terminal row
	 * @param {number} col 1-based terminal column
	 * @returns {RenderRegion | null}
	 */
	regionAt(row, col) {
		const point = this.hitTestCell(row, col)
		return point ? this.regionAtPoint(point) : null
	}

	/** @param {number} lineIndex */
	selectableLineWidth(lineIndex) {
		const line = this.lines[lineIndex] ?? ""
		return isImageLine(line) ? 0 : visibleWidth(line)
	}

	/**
	 * Return the word-like range under a rendered-screen point. Whitespace is not a word target; punctuation forms its own selectable run, matching editor word movement semantics.
	 * @param {ScreenPoint | null} point
	 * @returns {ScreenRange | null}
	 */
	wordRangeAtPoint(point) {
		const sourceRange = this.sourceUnitRangeAtPoint(point, "word")
		if (sourceRange) return sourceRange
		if (!point || point.line < 0 || point.line >= this.lines.length) return null
		const line = this.lines[point.line] ?? ""
		if (isImageLine(line)) return null
		const col = Math.floor(point.col)
		const units = selectionUnitsForLine(line)
		const hitIndex = units.findIndex((unit) => col >= unit.startCol && col < unit.endCol)
		if (hitIndex === -1) return null

		const hit = units[hitIndex]
		if (hit.kind === "space") return null

		let startIndex = hitIndex
		while (startIndex > 0 && units[startIndex - 1].kind === hit.kind) startIndex--
		let endIndex = hitIndex
		while (endIndex + 1 < units.length && units[endIndex + 1].kind === hit.kind) endIndex++

		return {
			start: { line: point.line, col: units[startIndex].startCol },
			end: { line: point.line, col: units[endIndex].endCol },
		}
	}

	/**
	 * Return the selectable line range under a rendered-screen point. Source-backed content selects the original semantic line, which may span several wrapped terminal rows; otherwise this falls back to the rendered terminal row.
	 * @param {ScreenPoint | null} point
	 * @returns {ScreenRange | null}
	 */
	lineRangeAtPoint(point) {
		const sourceRange = this.sourceUnitRangeAtPoint(point, "line")
		if (sourceRange) return sourceRange
		if (!point || point.line < 0 || point.line >= this.lines.length) return null
		const line = this.lines[point.line] ?? ""
		if (isImageLine(line)) return null
		const lineWidth = this.selectableLineWidth(point.line)
		if (lineWidth <= 0) return null
		return {
			start: { line: point.line, col: 0 },
			end: { line: point.line, col: lineWidth },
		}
	}

	/**
	 * @param {ScreenPoint | null} point
	 * @param {import("./selection-source.js").SelectionSourceUnit} unit
	 * @returns {ScreenRange | null}
	 */
	sourceUnitRangeAtPoint(point, unit) {
		if (!point) return null
		const span = this.sourceSpanAtPoint(point)
		if (!span || span.ignore || typeof span.provider?.rangeForUnit !== "function") return null
		const offset = sourceOffsetForPoint(span, point)
		const sourceRange = span.provider.rangeForUnit(offset, unit)
		if (!sourceRange) return null
		return this.screenRangeForSourceRange(span, sourceRange)
	}

	/**
	 * @param {RenderSourceSpan} anchor
	 * @param {{ start: number, end: number }} sourceRange
	 * @returns {ScreenRange | null}
	 */
	screenRangeForSourceRange(anchor, sourceRange) {
		const spans = this.sourceSpans
			.filter((span) => !span.ignore && span.provider === anchor.provider && span.sourceId === anchor.sourceId)
			.flatMap((span) => {
				const sourceStart = Math.max(span.sourceStart, sourceRange.start)
				const sourceEnd = Math.min(span.sourceEnd, sourceRange.end)
				if (sourceEnd <= sourceStart) return []
				return [{
					span,
					startCol: span.startCol + sourceColumnAtOffset(span, sourceStart, "start"),
					endCol: span.startCol + sourceColumnAtOffset(span, sourceEnd, "end"),
				}]
			})
			.filter((span) => span.endCol > span.startCol)
			.sort((a, b) => a.span.line - b.span.line || a.startCol - b.startCol)
		if (spans.length === 0) return null
		const first = spans[0]
		const last = spans[spans.length - 1]
		return {
			start: { line: first.span.line, col: first.startCol },
			end: { line: last.span.line, col: last.endCol },
		}
	}

	/**
	 * @param {ScreenRange | null} range
	 * @returns {string}
	 */
	textForRange(range) {
		range = normalizeRange(range)
		if (!range || !rangeHasText(range)) return ""
		const parts = []
		for (let i = range.start.line; i <= range.end.line; i++) {
			const line = this.lines[i] ?? ""
			if (isImageLine(line)) {
				parts.push("")
				continue
			}
			const lineWidth = this.selectableLineWidth(i)
			const startCol = i === range.start.line ? Math.min(range.start.col, lineWidth) : 0
			const endCol = i === range.end.line ? Math.min(range.end.col, lineWidth) : lineWidth
			parts.push(stripTerminalControls(sliceByColumn(line, startCol, Math.max(0, endCol - startCol), true)))
		}
		return parts.join("\n")
	}

	/**
	 * Return semantic copy text when the selected content has source metadata,
	 * otherwise fall back to rendered terminal text.
	 * @param {ScreenRange | null} range
	 * @returns {string}
	 */
	copyTextForRange(range) {
		const semantic = this.semanticTextForRange(range)
		return semantic ?? this.textForRange(range)
	}

	/**
	 * @param {ScreenRange | null} range
	 * @returns {string | null}
	 */
	semanticTextForRange(range) {
		range = normalizeRange(range)
		if (!range || !rangeHasText(range)) return ""
		const pieces = this.sourcePiecesForRange(range)
		if (pieces === null) return null
		if (pieces.length === 0) return ""
		return serializeSourcePieces(pieces)
	}

	/**
	 * @param {ScreenRange} range
	 * @returns {RenderSourceSpan[] | null}
	 */
	sourcePiecesForRange(range) {
		/** @type {RenderSourceSpan[]} */
		const pieces = []
		for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex++) {
			const lineWidth = this.selectableLineWidth(lineIndex)
			const startCol = lineIndex === range.start.line ? Math.min(range.start.col, lineWidth) : 0
			const endCol = lineIndex === range.end.line ? Math.min(range.end.col, lineWidth) : lineWidth
			if (endCol <= startCol) continue

			const lineSpans = this.sourceSpans
				.filter((span) => span.line === lineIndex && span.endCol > startCol && span.startCol < endCol)
				.flatMap((span) => {
					const clipped = clipSourceSpanColumns(span, startCol, endCol)
					return clipped ? [clipped] : []
				})
				.sort((a, b) => a.startCol - b.startCol)
			if (lineSpans.length > 0) {
				if (!coveredOrWhitespaceOnly(this.lines[lineIndex] ?? "", startCol, endCol, lineSpans)) return null
				pieces.push(...lineSpans.filter((span) => !span.ignore))
				continue
			}

			const rendered = stripTerminalControls(sliceByColumn(this.lines[lineIndex] ?? "", startCol, endCol - startCol, true))
			if (rendered.trim() !== "") return null
		}
		return pieces
	}

	/**
	 * @param {ScreenRange | null} range
	 * @returns {string[]}
	 */
	linesWithHighlight(range) {
		range = normalizeRange(range)
		if (!range || !rangeHasText(range)) return this.lines
		return this.lines.map((line, index) => this.highlightLine(line, index, range))
	}

	/**
	 * @param {string} line
	 * @param {number} lineIndex
	 * @param {ScreenRange} range
	 */
	highlightLine(line, lineIndex, range) {
		if (isImageLine(line) || lineIndex < range.start.line || lineIndex > range.end.line) return line
		const lineWidth = this.selectableLineWidth(lineIndex)
		const startCol = lineIndex === range.start.line ? Math.min(range.start.col, lineWidth) : 0
		const endCol = lineIndex === range.end.line ? Math.min(range.end.col, lineWidth) : lineWidth
		if (endCol <= startCol) return line
		const before = sliceByColumn(line, 0, startCol, true)
		const selected = sliceByColumn(line, startCol, endCol - startCol, true)
		const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true)
		return `${before}${withInverseStyle(selected)}${after}`
	}
}

/** @param {ScreenRange | null} range */
function normalizeRange(range) {
	if (!range) return null
	return comparePoints(range.start, range.end) <= 0
		? range
		: { start: range.end, end: range.start }
}

/**
 * @param {ScreenPoint} a
 * @param {ScreenPoint} b
 */
function comparePoints(a, b) {
	if (a.line !== b.line) return a.line - b.line
	return a.col - b.col
}

/** @param {ScreenRange} range */
function rangeHasText(range) {
	return range.start.line !== range.end.line || range.start.col !== range.end.col
}

/**
 * @param {string[]} lines
 * @param {number} height
 */
function viewportTopForLines(lines, height) {
	return Math.max(0, lines.length - height)
}

/** @param {number} value */
function normalizePositiveInteger(value) {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** @param {string} segment @returns {SelectionUnitKind} */
function selectionUnitKind(segment) {
	if (isWhitespaceChar(segment)) return "space"
	if (isPunctuationChar(segment)) return "punctuation"
	return "word"
}

/**
 * @param {string} line
 * @returns {SelectionUnit[]}
 */
function selectionUnitsForLine(line) {
	/** @type {SelectionUnit[]} */
	const units = []
	let currentCol = 0

	for (let i = 0; i < line.length;) {
		const ansi = extractAnsiCode(line, i)
		if (ansi) {
			i += ansi.length
			continue
		}

		let textEnd = i
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++

		for (const { segment } of getSegmenter().segment(line.slice(i, textEnd))) {
			const width = visibleWidth(segment)
			const nextCol = currentCol + width
			if (width > 0) {
				units.push({
					startCol: currentCol,
					endCol: nextCol,
					kind: selectionUnitKind(segment),
				})
			}
			currentCol = nextCol
		}

		i = textEnd
	}

	return units
}

/** @param {string} text */
function stripTerminalControls(text) {
	let result = ""
	for (let i = 0; i < text.length;) {
		const ansi = extractAnsiCode(text, i)
		if (ansi) {
			i += ansi.length
			continue
		}
		result += text[i]
		i++
	}
	return result
}

/**
 * @param {RenderSourceSpan[]} pieces
 * @returns {string}
 */
function serializeSourcePieces(pieces) {
	/** @type {Array<{ text: string, startLine: number, endLine: number, startCol: number, endCol: number }>} */
	const chunks = []
	let current = /** @type {(RenderSourceSpan & { startLine: number, endLine: number }) | null} */ (null)
	const flush = () => {
		if (!current) return
		chunks.push({
			text: String(current.provider.textForRange({ start: current.sourceStart, end: current.sourceEnd }) ?? ""),
			startLine: current.startLine,
			endLine: current.endLine,
			startCol: current.startCol,
			endCol: current.endCol,
		})
		current = null
	}

	for (const piece of pieces) {
		if (
			current
			&& current.provider === piece.provider
			&& current.sourceId === piece.sourceId
			&& piece.sourceStart >= current.sourceStart
			&& piece.sourceStart <= current.sourceEnd
		) {
			current.sourceEnd = Math.max(current.sourceEnd, piece.sourceEnd)
			current.endLine = piece.line
			current.endCol = piece.endCol
			continue
		}
		if (
			current
			&& current.provider === piece.provider
			&& current.sourceId === piece.sourceId
			&& piece.sourceStart >= current.sourceEnd
			&& sourceGapIsWhitespace(current, piece)
		) {
			current.sourceEnd = piece.sourceEnd
			current.endLine = piece.line
			current.endCol = piece.endCol
			continue
		}
		flush()
		current = { ...piece, startLine: piece.line, endLine: piece.line }
	}
	flush()
	return chunks.reduce((result, chunk, index) => {
		if (index === 0) return chunk.text
		const previous = chunks[index - 1]
		const separator = chunk.startLine === previous.endLine
			? " ".repeat(Math.max(0, chunk.startCol - previous.endCol))
			: "\n"
		return result + separator + chunk.text
	}, "")
}

/**
 * @param {string} line
 * @param {number} startCol
 * @param {number} endCol
 * @param {RenderSourceSpan[]} spans
 * @returns {boolean}
 */
function coveredOrWhitespaceOnly(line, startCol, endCol, spans) {
	let cursor = startCol
	for (const span of spans) {
		if (span.startCol > cursor && hasNonWhitespaceCells(line, cursor, span.startCol)) return false
		cursor = Math.max(cursor, span.endCol)
		if (cursor >= endCol) return true
	}
	return !hasNonWhitespaceCells(line, cursor, endCol)
}

/**
 * @param {string} line
 * @param {number} startCol
 * @param {number} endCol
 */
function hasNonWhitespaceCells(line, startCol, endCol) {
	if (endCol <= startCol) return false
	const text = stripTerminalControls(sliceByColumn(line, startCol, endCol - startCol, true))
	return text.trim() !== ""
}

/**
 * @param {RenderSourceSpan} current
 * @param {RenderSourceSpan} next
 */
function sourceGapIsWhitespace(current, next) {
	if (next.sourceStart <= current.sourceEnd) return true
	const gap = current.provider.textForRange({ start: current.sourceEnd, end: next.sourceStart })
	return String(gap ?? "").trim() === ""
}

/**
 * @param {RenderSourceSpan} span
 * @param {ScreenPoint} point
 * @returns {number}
 */
function sourceOffsetForPoint(span, point) {
	const clipped = clipSourceSpanColumns(span, point.col, span.endCol)
	return clipped?.sourceStart ?? span.sourceStart
}

/**
 * @param {RenderSourceSpan} span
 * @param {number} sourceOffset
 * @param {"start" | "end"} bias
 * @returns {number}
 */
function sourceColumnAtOffset(span, sourceOffset, bias) {
	const target = Math.max(span.sourceStart, Math.min(span.sourceEnd, Math.floor(sourceOffset)))
	const text = String(span.provider.textForRange({ start: span.sourceStart, end: span.sourceEnd }) ?? "")
	let offset = span.sourceStart
	let col = 0
	for (const { segment } of getSegmenter().segment(text)) {
		const nextOffset = offset + segment.length
		const width = sourceSegmentWidth(segment)
		if (target <= offset) return col
		if (target < nextOffset) return bias === "end" ? col + width : col
		if (target === nextOffset) return col + width
		offset = nextOffset
		col += width
	}
	return col
}

/** @param {string} segment */
function sourceSegmentWidth(segment) {
	if (segment === "\t") return 3
	return visibleWidth(segment)
}

/** @param {string} text */
function withInverseStyle(text) {
	let result = "\x1b[7m"
	for (let i = 0; i < text.length;) {
		const ansi = extractAnsiCode(text, i)
		if (ansi) {
			result += ansi.code
			if (ansi.code.endsWith("m")) result += "\x1b[7m"
			i += ansi.length
			continue
		}
		result += text[i]
		i++
	}
	return `${result}\x1b[27m`
}
