/**
 * Small line-oriented viewport helper for TUI components that render more rows
 * than their parent can safely put on screen.
 *
 * It deliberately works on already-rendered lines. That keeps it usable for
 * grouped/variable-height views where rows can expand into several terminal
 * lines, while still centralizing the scroll/anchor math.
 */

/**
 * @typedef {object} ViewportResult
 * @property {string[]} lines
 * @property {(number | null)[]} sourceLineIndexes Source line indexes for `lines`; indicator rows are null.
 * @property {number} scrollOffset
 * @property {boolean} clipped
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value))
}

/**
 * @param {object} options
 * @param {string[]} options.lines
 * @param {number} options.maxLines
 * @param {number} [options.anchorLine]
 * @param {number} [options.scrollOffset]
 * @param {boolean} [options.preferScrollOffset]
 * @param {(hidden: number) => string} [options.topIndicator]
 * @param {(hidden: number) => string} [options.bottomIndicator]
 * @returns {ViewportResult}
 */
export function clipLinesToViewport(options) {
	const sourceLines = options.lines
	const total = sourceLines.length
	const maxLines = Math.floor(options.maxLines)
	if (!Number.isFinite(maxLines)) return { lines: sourceLines, sourceLineIndexes: sourceLines.map((_, index) => index), scrollOffset: 0, clipped: false }
	if (maxLines <= 0) return { lines: [], sourceLineIndexes: [], scrollOffset: 0, clipped: total > 0 }
	if (total <= maxLines) return { lines: sourceLines, sourceLineIndexes: sourceLines.map((_, index) => index), scrollOffset: 0, clipped: false }

	const previousScrollOffset = clamp(Math.floor(options.scrollOffset ?? 0), 0, Math.max(0, total - 1))

	// In very small viewports, content is more important than indicators.
	if (maxLines < 3) {
		const count = Math.max(1, maxLines)
		let start = clamp(previousScrollOffset, 0, Math.max(0, total - count))
		if (!options.preferScrollOffset) {
			const anchorLine = clamp(Math.floor(options.anchorLine ?? previousScrollOffset), 0, total - 1)
			if (anchorLine < start) start = anchorLine
			else if (anchorLine >= start + count) start = anchorLine - count + 1
			start = clamp(start, 0, Math.max(0, total - count))
		}
		return {
			lines: sourceLines.slice(start, start + count),
			sourceLineIndexes: sourceLines.slice(start, start + count).map((_, index) => start + index),
			scrollOffset: start,
			clipped: true,
		}
	}

	if (options.preferScrollOffset) {
		const contentRowsAtBottom = Math.max(1, maxLines - 1)
		const maxStart = Math.max(0, total - contentRowsAtBottom)
		const start = clamp(previousScrollOffset, 0, maxStart)
		const top = start > 0
		let contentCapacity = maxLines - (top ? 1 : 0)
		let end = Math.min(total, start + contentCapacity)
		const bottom = end < total
		if (bottom) {
			contentCapacity = Math.max(1, contentCapacity - 1)
			end = Math.min(total, start + contentCapacity)
		}
		const out = []
		const sourceLineIndexes = []
		if (top) {
			out.push(options.topIndicator?.(start) ?? `↑ ${start} more`)
			sourceLineIndexes.push(null)
		}
		out.push(...sourceLines.slice(start, end))
		sourceLineIndexes.push(...sourceLines.slice(start, end).map((_, index) => start + index))
		if (bottom) {
			out.push(options.bottomIndicator?.(total - end) ?? `↓ ${total - end} more`)
			sourceLineIndexes.push(null)
		}
		return { lines: out, sourceLineIndexes, scrollOffset: start, clipped: true }
	}

	const anchorLine = clamp(Math.floor(options.anchorLine ?? previousScrollOffset), 0, total - 1)

	let best = /** @type {undefined | { start: number, end: number, top: boolean, bottom: boolean, score: number }} */ (undefined)
	for (let start = 0; start < total; start++) {
		const top = start > 0
		for (const bottom of [false, true]) {
			const contentCapacity = maxLines - (top ? 1 : 0) - (bottom ? 1 : 0)
			if (contentCapacity <= 0) continue
			const end = Math.min(total, start + contentCapacity)
			if ((end < total) !== bottom) continue
			if (anchorLine < start || anchorLine >= end) continue

			const visibleContent = end - start
			const anchorPosition = anchorLine - start
			const edgePenalty = (top && anchorPosition === 0 ? 1 : 0) + (bottom && anchorPosition === visibleContent - 1 ? 1 : 0)
			const unusedLines = maxLines - (visibleContent + (top ? 1 : 0) + (bottom ? 1 : 0))
			const distanceFromPrevious = Math.abs(start - previousScrollOffset)
			const distanceFromCenter = Math.abs(anchorPosition - Math.floor((visibleContent - 1) / 2))
			const score = edgePenalty * 1_000_000 + distanceFromPrevious * 1_000 + unusedLines * 100 + distanceFromCenter

			if (!best || score < best.score) best = { start, end, top, bottom, score }
		}
	}

	// There is always at least one valid window for maxLines >= 3, but keep a
	// conservative fallback so callers never lose content because of a math bug.
	if (!best) {
		const count = Math.max(1, maxLines - 1)
		const start = clamp(anchorLine, 0, Math.max(0, total - count))
		const end = Math.min(total, start + count)
		return {
			lines: sourceLines.slice(start, end),
			sourceLineIndexes: sourceLines.slice(start, end).map((_, index) => start + index),
			scrollOffset: start,
			clipped: true,
		}
	}

	const out = []
	const sourceLineIndexes = []
	if (best.top) {
		out.push(options.topIndicator?.(best.start) ?? `↑ ${best.start} more`)
		sourceLineIndexes.push(null)
	}
	out.push(...sourceLines.slice(best.start, best.end))
	sourceLineIndexes.push(...sourceLines.slice(best.start, best.end).map((_, index) => best.start + index))
	if (best.bottom) {
		out.push(options.bottomIndicator?.(total - best.end) ?? `↓ ${total - best.end} more`)
		sourceLineIndexes.push(null)
	}
	return { lines: out, sourceLineIndexes, scrollOffset: best.start, clipped: true }
}
