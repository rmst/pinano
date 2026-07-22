import { getSegmenter, visibleWidth } from "./utils.js"

/**
 * @typedef {object} RenderSpan
 * @property {number} line Rendered line index in the owning frame.
 * @property {number} startCol Inclusive visible-column start.
 * @property {number} endCol Exclusive visible-column end.
 * @property {any} [component] Owning component, when there is one.
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [label]
 * @property {any} [metadata]
 * @property {(event: any) => any} [onClick]
 * @property {(event: any) => any} [onContextMenu]
 * @property {(event: any) => any} [onMouse]
 */

/**
 * @typedef {import("./selection-source.js").TextSelectionSource} TextSelectionSource
 */

/**
 * @typedef {object} RenderSourceSpan
 * @property {number} line Rendered line index in the owning frame.
 * @property {number} startCol Inclusive visible-column start.
 * @property {number} endCol Exclusive visible-column end.
 * @property {TextSelectionSource} [provider] Component-owned semantic copy provider.
 * @property {string} [sourceId] Stable source identity. Defaults to `provider.id`.
 * @property {number} [sourceStart] Inclusive source-text offset.
 * @property {number} [sourceEnd] Exclusive source-text offset.
 * @property {boolean} [ignore] If true, the rendered range is selectable decoration and is omitted from semantic copy.
 * @property {any} [component] Owning component, when there is one.
 * @property {string} [role]
 * @property {any} [metadata]
 */

/**
 * @typedef {object} RenderRegion
 * @property {number} line Rendered line index in the owning frame.
 * @property {number} startCol Inclusive visible-column start.
 * @property {number} endCol Exclusive visible-column end.
 * @property {any} component Owning component.
 * @property {number} [componentLine] Component-local rendered line for routed mouse events.
 * @property {number} [componentStartCol] Component-local start column for routed mouse events.
 */

/**
 * @typedef {object} RenderFrame
 * @property {string[]} lines
 * @property {RenderSpan[]} spans
 * @property {RenderSourceSpan[]} sourceSpans
 * @property {RenderRegion[]} regions
 */

/**
 * @param {any} value
 * @returns {RenderFrame}
 */
export function normalizeRenderFrame(value) {
	if (Array.isArray(value)) return { lines: value, spans: [], sourceSpans: [], regions: [] }
	if (value && Array.isArray(value.lines)) {
		return {
			lines: value.lines,
			spans: normalizeSpans(value.spans ?? []),
			sourceSpans: normalizeSourceSpans(value.sourceSpans ?? []),
			regions: normalizeRegions(value.regions ?? []),
		}
	}
	return { lines: [], spans: [], sourceSpans: [], regions: [] }
}

/**
 * @param {RenderSpan[]} spans
 * @returns {RenderSpan[]}
 */
export function normalizeSpans(spans) {
	if (!Array.isArray(spans)) return []
	return spans.flatMap((span) => {
		const line = normalizeInteger(span?.line)
		const startCol = normalizeInteger(span?.startCol)
		const endCol = normalizeInteger(span?.endCol)
		if (line === null || startCol === null || endCol === null) return []
		if (line < 0 || startCol < 0 || endCol <= startCol) return []
		return [{ ...span, line, startCol, endCol }]
	})
}

/**
 * @param {RenderSourceSpan[]} sourceSpans
 * @returns {RenderSourceSpan[]}
 */
export function normalizeSourceSpans(sourceSpans) {
	if (!Array.isArray(sourceSpans)) return []
	return sourceSpans.flatMap((span) => {
		const line = normalizeInteger(span?.line)
		const startCol = normalizeInteger(span?.startCol)
		const endCol = normalizeInteger(span?.endCol)
		const sourceStart = normalizeInteger(span?.sourceStart)
		const sourceEnd = normalizeInteger(span?.sourceEnd)
		const provider = span?.provider
		const ignore = span?.ignore === true
		const sourceId = typeof span?.sourceId === "string" && span.sourceId.length > 0
			? span.sourceId
			: typeof provider?.id === "string" && provider.id.length > 0
				? provider.id
				: undefined
		if (line === null || startCol === null || endCol === null) return []
		if (line < 0 || startCol < 0 || endCol <= startCol) return []
		if (ignore) return [{ ...span, line, startCol, endCol, ignore: true }]
		if (sourceStart === null || sourceEnd === null || sourceEnd <= sourceStart) return []
		if (!provider || typeof provider.textForRange !== "function" || !sourceId) return []
		return [{ ...span, line, startCol, endCol, provider, sourceId, sourceStart, sourceEnd }]
	})
}

/**
 * @param {RenderRegion[]} regions
 * @returns {RenderRegion[]}
 */
export function normalizeRegions(regions) {
	if (!Array.isArray(regions)) return []
	return regions.flatMap((region) => {
		const line = normalizeInteger(region?.line)
		const startCol = normalizeInteger(region?.startCol)
		const endCol = normalizeInteger(region?.endCol)
		if (line === null || startCol === null || endCol === null) return []
		if (line < 0 || startCol < 0 || endCol <= startCol || !region?.component) return []
		return [{ ...region, line, startCol, endCol }]
	})
}

/**
 * @param {RenderSpan} span
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderSpan}
 */
export function offsetSpan(span, lineOffset, colOffset = 0) {
	return {
		...span,
		line: span.line + lineOffset,
		startCol: span.startCol + colOffset,
		endCol: span.endCol + colOffset,
	}
}

/**
 * @param {RenderSpan[]} spans
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderSpan[]}
 */
export function offsetSpans(spans, lineOffset, colOffset = 0) {
	return spans.map((span) => offsetSpan(span, lineOffset, colOffset))
}

/**
 * @param {RenderSourceSpan} span
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderSourceSpan}
 */
export function offsetSourceSpan(span, lineOffset, colOffset = 0) {
	return {
		...span,
		line: span.line + lineOffset,
		startCol: span.startCol + colOffset,
		endCol: span.endCol + colOffset,
	}
}

/**
 * @param {RenderSourceSpan[]} sourceSpans
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderSourceSpan[]}
 */
export function offsetSourceSpans(sourceSpans, lineOffset, colOffset = 0) {
	return sourceSpans.map((span) => offsetSourceSpan(span, lineOffset, colOffset))
}

/**
 * @param {RenderRegion} region
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderRegion}
 */
export function offsetRegion(region, lineOffset, colOffset = 0) {
	return {
		...region,
		line: region.line + lineOffset,
		startCol: region.startCol + colOffset,
		endCol: region.endCol + colOffset,
	}
}

/**
 * @param {RenderRegion[]} regions
 * @param {number} lineOffset
 * @param {number} [colOffset]
 * @returns {RenderRegion[]}
 */
export function offsetRegions(regions, lineOffset, colOffset = 0) {
	return regions.map((region) => offsetRegion(region, lineOffset, colOffset))
}

/**
 * @param {RenderSpan} span
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderSpan | null}
 */
export function clipSpanColumns(span, startCol, endCol) {
	const nextStart = Math.max(span.startCol, startCol)
	const nextEnd = Math.min(span.endCol, endCol)
	if (nextEnd <= nextStart) return null
	return { ...span, startCol: nextStart, endCol: nextEnd }
}

/**
 * @param {RenderSourceSpan} span
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderSourceSpan | null}
 */
export function clipSourceSpanColumns(span, startCol, endCol) {
	const nextStart = Math.max(span.startCol, startCol)
	const nextEnd = Math.min(span.endCol, endCol)
	if (nextEnd <= nextStart) return null
	if (span.ignore) return { ...span, startCol: nextStart, endCol: nextEnd }
	const text = sourceSpanText(span)
	const sourceStart = span.sourceStart + sourceOffsetAtColumn(text, nextStart - span.startCol, "start")
	const sourceEnd = span.sourceStart + sourceOffsetAtColumn(text, nextEnd - span.startCol, "end")
	if (sourceEnd <= sourceStart) return null
	return { ...span, startCol: nextStart, endCol: nextEnd, sourceStart, sourceEnd }
}

/**
 * @param {RenderRegion} region
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderRegion | null}
 */
export function clipRegionColumns(region, startCol, endCol) {
	const nextStart = Math.max(region.startCol, startCol)
	const nextEnd = Math.min(region.endCol, endCol)
	if (nextEnd <= nextStart) return null
	const clippedStart = nextStart - region.startCol
	const nextRegion = { ...region, startCol: nextStart, endCol: nextEnd }
	if (Number.isFinite(region.componentStartCol)) nextRegion.componentStartCol = Math.floor(region.componentStartCol) + clippedStart
	return nextRegion
}

/**
 * @param {RenderSpan[]} spans
 * @param {number} line
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderSpan[]}
 */
export function removeSpanColumns(spans, line, startCol, endCol) {
	if (endCol <= startCol) return spans
	return spans.flatMap((span) => {
		if (span.line !== line || span.endCol <= startCol || span.startCol >= endCol) return [span]
		const before = clipSpanColumns(span, span.startCol, startCol)
		const after = clipSpanColumns(span, endCol, span.endCol)
		return [before, after].filter(Boolean)
	})
}

/**
 * @param {RenderSourceSpan[]} sourceSpans
 * @param {number} line
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderSourceSpan[]}
 */
export function removeSourceSpanColumns(sourceSpans, line, startCol, endCol) {
	if (endCol <= startCol) return sourceSpans
	return sourceSpans.flatMap((span) => {
		if (span.line !== line || span.endCol <= startCol || span.startCol >= endCol) return [span]
		const before = clipSourceSpanColumns(span, span.startCol, startCol)
		const after = clipSourceSpanColumns(span, endCol, span.endCol)
		return [before, after].filter(Boolean)
	})
}

/**
 * @param {RenderRegion[]} regions
 * @param {number} line
 * @param {number} startCol
 * @param {number} endCol
 * @returns {RenderRegion[]}
 */
export function removeRegionColumns(regions, line, startCol, endCol) {
	if (endCol <= startCol) return regions
	return regions.flatMap((region) => {
		if (region.line !== line || region.endCol <= startCol || region.startCol >= endCol) return [region]
		const before = clipRegionColumns(region, region.startCol, startCol)
		const after = clipRegionColumns(region, endCol, region.endCol)
		return [before, after].filter(Boolean)
	})
}

/**
 * @param {RenderSpan[]} spans
 * @param {number} firstLine Inclusive source first line.
 * @param {number} lastLine Exclusive source last line.
 * @param {number} [lineOffset]
 * @returns {RenderSpan[]}
 */
export function sliceSpansByLine(spans, firstLine, lastLine, lineOffset = -firstLine) {
	return spans
		.filter((span) => span.line >= firstLine && span.line < lastLine)
		.map((span) => offsetSpan(span, lineOffset))
}

/**
 * @param {RenderSourceSpan[]} sourceSpans
 * @param {number} firstLine Inclusive source first line.
 * @param {number} lastLine Exclusive source last line.
 * @param {number} [lineOffset]
 * @returns {RenderSourceSpan[]}
 */
export function sliceSourceSpansByLine(sourceSpans, firstLine, lastLine, lineOffset = -firstLine) {
	return sourceSpans
		.filter((span) => span.line >= firstLine && span.line < lastLine)
		.map((span) => offsetSourceSpan(span, lineOffset))
}

/**
 * @param {RenderRegion[]} regions
 * @param {number} firstLine Inclusive source first line.
 * @param {number} lastLine Exclusive source last line.
 * @param {number} [lineOffset]
 * @returns {RenderRegion[]}
 */
export function sliceRegionsByLine(regions, firstLine, lastLine, lineOffset = -firstLine) {
	return regions
		.filter((region) => region.line >= firstLine && region.line < lastLine)
		.map((region) => offsetRegion(region, lineOffset))
}

/**
 * @param {number} value
 * @returns {number | null}
 */
function normalizeInteger(value) {
	if (!Number.isFinite(value)) return null
	return Math.floor(value)
}

/**
 * @param {RenderSourceSpan} span
 * @returns {string}
 */
function sourceSpanText(span) {
	return String(span.provider.textForRange({ start: span.sourceStart, end: span.sourceEnd }) ?? "")
}

/**
 * @param {string} text
 * @param {number} targetCol
 * @param {"start" | "end"} bias
 * @returns {number}
 */
function sourceOffsetAtColumn(text, targetCol, bias) {
	const target = Math.max(0, Math.floor(targetCol))
	let offset = 0
	let col = 0
	for (const { segment } of getSegmenter().segment(text)) {
		const nextOffset = offset + segment.length
		const width = sourceSegmentWidth(segment)
		const nextCol = col + width
		if (target <= col) return offset
		if (target < nextCol) return bias === "start" ? offset : offset
		if (target === nextCol) return nextOffset
		offset = nextOffset
		col = nextCol
	}
	return text.length
}

/** @param {string} segment */
function sourceSegmentWidth(segment) {
	if (segment === "\t") return 3
	return visibleWidth(segment)
}
