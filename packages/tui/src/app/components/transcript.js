import { RetainedContainer, Spacer, clipRegionColumns, clipSourceSpanColumns, clipSpanColumns, normalizeRenderFrame, offsetRegions, offsetSourceSpans, offsetSpans, sliceRegionsByLine, sliceSourceSpansByLine, sliceSpansByLine, visibleWidth } from "../../tui/index.js"
import { sliceByColumn } from "../../tui/utils.js"
import { theme } from "../theme.js"

/** @typedef {"user" | "assistant" | "tool" | "custom" | "separator"} TranscriptItemKind */
/**
 * @typedef {object} TranscriptItemOptions
 * @property {string} [collapseGroupId]
 * @property {boolean} [collapseTailAnchor]
 * @property {string} [completesCollapseGroupId]
 * @property {"step" | "compaction"} [collapseItemKind]
 */

const DEFAULT_COLLAPSED_TAIL_ITEMS = 2

export const TRANSCRIPT_INDENT = Object.freeze({
	none: 0,
	primary: 1,
	secondary: 1,
	toolBlock: 1,
})

/** @param {TranscriptItemKind} kind */
function outerIndentForKind(kind) {
	if (kind === "tool") return TRANSCRIPT_INDENT.toolBlock
	if (kind === "custom") return TRANSCRIPT_INDENT.secondary
	return TRANSCRIPT_INDENT.none
}

/**
 * @param {number} width
 * @param {number} indent
 */
function effectiveIndent(width, indent) {
	return Math.max(0, Math.min(indent, Math.max(0, width - 1)))
}

/**
 * @param {string} line
 * @param {number} indent
 * @param {number} contentWidth
 */
function indentLine(line, indent, contentWidth) {
	if (indent <= 0 || line === "") return line
	const clipped = visibleWidth(line) > contentWidth ? sliceByColumn(line, 0, contentWidth, true) : line
	return `${" ".repeat(indent)}${clipped}`
}

/**
 * @param {import("../../tui/render-frame.js").RenderSpan[]} spans
 * @param {number} contentWidth
 */
function clipSpansToContent(spans, contentWidth) {
	return spans.flatMap((span) => clipSpanColumns(span, 0, contentWidth) ?? [])
}

/**
 * @param {import("../../tui/render-frame.js").RenderSourceSpan[]} sourceSpans
 * @param {number} contentWidth
 */
function clipSourceSpansToContent(sourceSpans, contentWidth) {
	return sourceSpans.flatMap((span) => clipSourceSpanColumns(span, 0, contentWidth) ?? [])
}

/**
 * @param {import("../../tui/render-frame.js").RenderRegion[]} regions
 * @param {number} contentWidth
 */
function clipRegionsToContent(regions, contentWidth) {
	return regions.flatMap((region) => clipRegionColumns(region, 0, contentWidth) ?? [])
}

/**
 * Transcript layout owns spacing between visible chat items. Message and tool
 * components own only their internal padding, while this container keeps tool
 * groups compact and skips invisible streaming placeholders.
 */
export class TranscriptContainer extends RetainedContainer {
	/** @type {WeakMap<import("../../tui/index.js").Component, TranscriptItemKind>} */
	itemKinds = new WeakMap()
	/** @type {WeakMap<import("../../tui/index.js").Component, TranscriptItemOptions>} */
	itemOptions = new WeakMap()
	/** @type {Set<string>} */
	expandedCollapseGroups = new Set()
	/** @type {string | undefined} */
	activeCollapseGroupId = undefined
	collapseStateDirty = false
	collapsedTailVisibleItems = DEFAULT_COLLAPSED_TAIL_ITEMS

	/** @param {import("../../tui/index.js").Component} component */
	addChild(component) {
		this.addItem(component, "custom")
	}

	/**
	 * @param {import("../../tui/index.js").Component} component
	 * @param {TranscriptItemKind} kind
	 * @param {TranscriptItemOptions} [options]
	 */
	addItem(component, kind, options = {}) {
		this.itemKinds.set(component, kind)
		this.itemOptions.set(component, options)
		super.addChild(component)
	}

	addSeparator() {
		const last = this.children[this.children.length - 1]
		if (last && this.kindFor(last) === "separator") return
		const spacer = new Spacer(1)
		this.itemKinds.set(spacer, "separator")
		super.addChild(spacer)
	}

	/** @param {import("../../tui/index.js").Component} component */
	removeChild(component) {
		this.itemKinds.delete(component)
		this.itemOptions.delete(component)
		super.removeChild(component)
	}

	clear() {
		this.itemKinds = new WeakMap()
		this.itemOptions = new WeakMap()
		this.expandedCollapseGroups.clear()
		this.activeCollapseGroupId = undefined
		this.collapseStateDirty = false
		super.clear()
	}

	/**
	 * @param {import("../../tui/index.js").Component} component
	 * @returns {TranscriptItemKind}
	 */
	kindFor(component) {
		return this.itemKinds.get(component) ?? "custom"
	}

	/** @param {import("../../tui/index.js").Component} component */
	collapseGroupFor(component) {
		return this.itemOptions.get(component)?.collapseGroupId
	}

	/** @param {import("../../tui/index.js").Component} component */
	collapseTailAnchorFor(component) {
		return this.itemOptions.get(component)?.collapseTailAnchor === true
	}

	/** @param {import("../../tui/index.js").Component} component */
	completedCollapseGroupIdFor(component) {
		return this.itemOptions.get(component)?.completesCollapseGroupId
	}

	/** @param {import("../../tui/index.js").Component} component */
	collapseItemKindFor(component) {
		return this.itemOptions.get(component)?.collapseItemKind ?? "step"
	}

	/** @param {string} groupId */
	toggleCollapseGroup(groupId) {
		if (this.expandedCollapseGroups.has(groupId)) this.expandedCollapseGroups.delete(groupId)
		else this.expandedCollapseGroups.add(groupId)
		this.collapseStateDirty = true
		this.markDirty()
	}

	/** @param {string | undefined} groupId */
	setActiveCollapseGroup(groupId) {
		if (this.activeCollapseGroupId === groupId) return
		this.activeCollapseGroupId = groupId
		this.collapseStateDirty = true
		this.markDirty()
	}

	/**
	 * @param {TranscriptItemKind | undefined} previousKind
	 * @param {TranscriptItemKind} kind
	 */
	shouldSeparate(previousKind, kind) {
		if (!previousKind) return false
		if (kind === "separator") return false
		if (previousKind === "tool" && kind === "tool") return false
		if (previousKind === "custom" && kind === "custom") return false
		return true
	}

	/**
	 * @param {Array<{ component: import("../../tui/index.js").Component, start: number, length: number }>} childRecords
	 * @returns {{ hiddenComponents: Set<import("../../tui/index.js").Component>, summariesByComponent: Map<import("../../tui/index.js").Component, { groupId: string, expanded: boolean, stepCount: number, compactionCount: number, partial: boolean, key?: string }> }}
	 */
	collapsePlan(childRecords) {
		/** @type {Map<string, { items: Array<{ component: import("../../tui/index.js").Component, tailAnchor: boolean, itemKind: "step" | "compaction" }>, completed: boolean }>} */
		const groups = new Map()
		/** @type {Set<string>} */
		const completedGroupIds = new Set()
		/** @type {string | undefined} */
		let lastRenderedGroupId
		for (const record of childRecords) {
			if (record.length <= 0) continue
			const groupId = this.collapseGroupFor(record.component)
			if (groupId) {
				let group = groups.get(groupId)
				if (!group) {
					group = { items: [], completed: completedGroupIds.has(groupId) }
					groups.set(groupId, group)
					lastRenderedGroupId = groupId
				}
				group.items.push({
					component: record.component,
					tailAnchor: this.collapseTailAnchorFor(record.component),
					itemKind: this.collapseItemKindFor(record.component),
				})
			}
			const completedGroupId = this.completedCollapseGroupIdFor(record.component)
			if (completedGroupId) {
				completedGroupIds.add(completedGroupId)
				const group = groups.get(completedGroupId)
				if (group) group.completed = true
			}
		}

		/**
		 * @param {{ items: Array<{ component: import("../../tui/index.js").Component, tailAnchor: boolean, itemKind: "step" | "compaction" }>, completed: boolean }} group
		 * @param {boolean} keepTail
		 */
		const firstVisibleIndexForGroup = (group, keepTail) => {
			if (!keepTail) return group.items.length
			for (let i = group.items.length - 1; i >= 0; i--) {
				if (group.items[i].tailAnchor) return i
			}
			return Math.max(0, group.items.length - Math.max(0, this.collapsedTailVisibleItems))
		}

		const latestGroupId = this.activeCollapseGroupId ?? lastRenderedGroupId
		/** @type {Set<import("../../tui/index.js").Component>} */
		const hiddenComponents = new Set()
		/** @type {Map<import("../../tui/index.js").Component, { groupId: string, expanded: boolean, stepCount: number, compactionCount: number, partial: boolean, key?: string }>} */
		const summariesByComponent = new Map()

		/** @param {Array<{ itemKind: "step" | "compaction" }>} items */
		const itemCounts = (items) => items.reduce((counts, item) => {
			if (item.itemKind === "compaction") counts.compactionCount += 1
			else counts.stepCount += 1
			return counts
		}, { stepCount: 0, compactionCount: 0 })
		const childIndexByComponent = new Map(childRecords.map((record, index) => [record.component, index]))
		/**
		 * @param {Array<{ component: import("../../tui/index.js").Component, tailAnchor: boolean, itemKind: "step" | "compaction" }>} items
		 * @returns {Array<Array<{ component: import("../../tui/index.js").Component, tailAnchor: boolean, itemKind: "step" | "compaction" }>>}
		 */
		const contiguousRuns = (items) => items.reduce((runs, item) => {
			const lastRun = runs[runs.length - 1]
			const previous = lastRun?.[lastRun.length - 1]
			const previousIndex = previous ? childIndexByComponent.get(previous.component) ?? -1 : -1
			const currentIndex = childIndexByComponent.get(item.component) ?? -1
			if (lastRun && currentIndex === previousIndex + 1) lastRun.push(item)
			else runs.push([item])
			return runs
		}, /** @type {Array<Array<{ component: import("../../tui/index.js").Component, tailAnchor: boolean }>>} */ ([]))

		for (const [groupId, group] of groups) {
			const expanded = this.expandedCollapseGroups.has(groupId)
			const total = group.items.length
			if (total === 0) continue
			if (expanded) {
				summariesByComponent.set(group.items[0].component, { groupId, expanded: true, ...itemCounts(group.items), partial: false })
				continue
			}

			const keepTail = groupId === latestGroupId && !group.completed
			const firstVisibleIndex = firstVisibleIndexForGroup(group, keepTail)
			const hiddenPrefix = group.items.slice(0, firstVisibleIndex)
			contiguousRuns(hiddenPrefix).forEach((hidden, runIndex, runs) => {
				for (const item of hidden) hiddenComponents.add(item.component)
				summariesByComponent.set(hidden[0].component, {
					groupId,
					expanded: false,
					...itemCounts(hidden),
					partial: hidden.length < total,
					key: runs.length === 1 ? `collapse:${groupId}` : `collapse:${groupId}:${runIndex}`,
				})
			})
		}

		return { hiddenComponents, summariesByComponent }
	}

	/**
	 * @param {{ expanded: boolean, stepCount: number, compactionCount: number, partial: boolean }} summary
	 */
	collapseSummaryText(summary) {
		const marker = summary.expanded ? "▾" : "▸"
		const scope = summary.partial ? "earlier " : ""
		const state = summary.expanded ? "shown" : "hidden"
		const parts = []
		if (summary.stepCount > 0) parts.push(`${summary.stepCount} ${scope}${summary.stepCount === 1 ? "step" : "steps"}`)
		if (summary.compactionCount > 0) parts.push(`${summary.compactionCount} ${scope && parts.length === 0 ? scope : ""}${summary.compactionCount === 1 ? "compaction" : "compactions"}`)
		const countText = parts.length === 0 ? `0 ${scope}steps` : parts.join(" and ")
		return theme.dim(`${marker} ${countText} ${state}`)
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[], sourceSpans: import("../../tui/render-frame.js").RenderSourceSpan[], regions: import("../../tui/render-frame.js").RenderRegion[], dirtyStart: number }}
	 */
	renderIncremental(width) {
		const result = this.renderChildrenIncremental(width)
		const { hiddenComponents, summariesByComponent } = this.collapsePlan(result.childRecords)
		/** @type {string[]} */
		const lines = []
		/** @type {import("../../tui/render-frame.js").RenderSpan[]} */
		const spans = []
		/** @type {import("../../tui/render-frame.js").RenderSourceSpan[]} */
		const sourceSpans = []
		/** @type {import("../../tui/render-frame.js").RenderRegion[]} */
		const regions = []
		/** @type {TranscriptItemKind | undefined} */
		let previousKind
		const collapseStateDirty = this.collapseStateDirty
		let dirtyStart = collapseStateDirty ? 0 : Infinity

		/**
		 * @param {string} line
		 * @param {TranscriptItemKind} kind
		 * @param {boolean} dirty
		 * @param {import("../../tui/render-frame.js").RenderSpan[]} [generatedSpans]
		 */
		const appendGeneratedLine = (line, kind, dirty, generatedSpans = []) => {
			const itemStart = lines.length
			if (this.shouldSeparate(previousKind, kind) && lines[lines.length - 1] !== "") lines.push("")
			const outputStart = lines.length
			const indent = effectiveIndent(width, outerIndentForKind(kind))
			const contentWidth = Math.max(0, width - indent)
			if (dirty && dirtyStart === Infinity) dirtyStart = itemStart
			lines.push(indentLine(line, indent, contentWidth))
			spans.push(...offsetSpans(clipSpansToContent(generatedSpans, contentWidth), outputStart, indent))
			previousKind = kind
		}

		for (const record of result.childRecords) {
			const kind = this.kindFor(record.component)
			const childLines = result.lines.slice(record.start, record.start + record.length)
			const recordDirty = result.dirtyStart !== Infinity
				&& dirtyStart === Infinity
				&& record.start + Math.max(1, record.length) > result.dirtyStart

			if (kind === "separator") {
				if (recordDirty) dirtyStart = lines.length
				for (const line of childLines) lines.push(line)
				spans.push(...sliceSpansByLine(result.spans, record.start, record.start + record.length, lines.length - childLines.length - record.start))
				sourceSpans.push(...sliceSourceSpansByLine(result.sourceSpans, record.start, record.start + record.length, lines.length - childLines.length - record.start))
				regions.push(...sliceRegionsByLine(result.regions, record.start, record.start + record.length, lines.length - childLines.length - record.start))
				previousKind = undefined
				continue
			}

			if (childLines.length === 0) {
				if (recordDirty) dirtyStart = lines.length
				continue
			}

			const summary = summariesByComponent.get(record.component)
			if (summary) {
				const text = this.collapseSummaryText(summary)
				appendGeneratedLine(text, "tool", recordDirty, [{
					line: 0,
					startCol: 0,
					endCol: visibleWidth(text),
					component: this,
					id: summary.key ?? `collapse:${summary.groupId}`,
					role: "button",
					label: summary.expanded ? "collapse steps" : "expand steps",
					metadata: { groupId: summary.groupId },
					onClick: () => this.toggleCollapseGroup(summary.groupId),
				}])
			}
			if (hiddenComponents.has(record.component)) {
				if (recordDirty) dirtyStart = lines.length
				continue
			}

			const itemStart = lines.length
			if (this.shouldSeparate(previousKind, kind) && lines[lines.length - 1] !== "") lines.push("")
			const outputStart = lines.length
			const indent = effectiveIndent(width, outerIndentForKind(kind))
			const contentWidth = Math.max(0, width - indent)
			if (recordDirty) dirtyStart = itemStart
			for (const line of childLines) lines.push(indentLine(line, indent, contentWidth))
			spans.push(...offsetSpans(clipSpansToContent(sliceSpansByLine(result.spans, record.start, record.start + record.length, outputStart - record.start), contentWidth), 0, indent))
			sourceSpans.push(...offsetSourceSpans(clipSourceSpansToContent(sliceSourceSpansByLine(result.sourceSpans, record.start, record.start + record.length, outputStart - record.start), contentWidth), 0, indent))
			regions.push(...offsetRegions(clipRegionsToContent(sliceRegionsByLine(result.regions, record.start, record.start + record.length, outputStart - record.start), contentWidth), 0, indent))
			previousKind = kind
		}

		if (result.dirtyStart !== Infinity && dirtyStart === Infinity) dirtyStart = lines.length
		this.collapseStateDirty = false
		this.clearDirty()
		return { lines, spans, sourceSpans, regions, dirtyStart }
	}

	/** @param {number} width */
	render(width) {
		return this.renderIncremental(width).lines
	}
}

/**
 * App-owned transcript viewport. It clips the rendered transcript before it
 * reaches the terminal renderer, so terminal scrollback no longer owns old
 * session rows while this wrapper is mounted.
 */
export class TranscriptViewport {
	/** @type {TranscriptContainer} */
	transcript
	/** @type {(width: number) => number} */
	getMaxLines
	scrollOffset = 0
	followTail = true
	lastRenderedHeight = 0
	lastTotalLines = 0
	lastContentCapacity = 0

	/**
	 * @param {TranscriptContainer} transcript
	 * @param {{ getMaxLines: (width: number) => number }} options
	 */
	constructor(transcript, options) {
		this.transcript = transcript
		this.getMaxLines = options.getMaxLines
	}

	invalidate() {
		this.transcript.invalidate?.()
	}

	/** @returns {boolean} */
	canScroll() {
		return this.lastTotalLines > this.lastContentCapacity
	}

	maxScrollOffset() {
		return Math.max(0, this.lastTotalLines - this.lastContentCapacity)
	}

	/** @param {number} value */
	clampScrollOffset(value) {
		if (value === Infinity) return this.maxScrollOffset()
		if (!Number.isFinite(value)) return 0
		return Math.max(0, Math.min(this.maxScrollOffset(), Math.trunc(value)))
	}

	/**
	 * @param {number} offset
	 * @param {boolean} followTail
	 */
	setScrollOffset(offset, followTail) {
		const next = this.clampScrollOffset(offset)
		if (next === this.scrollOffset && this.followTail === followTail) return false
		this.scrollOffset = next
		this.followTail = followTail
		return true
	}

	/** @param {number} delta */
	scrollLines(delta) {
		if (!Number.isFinite(delta) || delta === 0 || !this.canScroll()) return false
		const next = this.clampScrollOffset(this.scrollOffset + Math.trunc(delta))
		return this.setScrollOffset(next, next >= this.maxScrollOffset())
	}

	/** @param {-1 | 1} direction */
	scrollPage(direction) {
		if (direction !== -1 && direction !== 1) return false
		const pageSize = Math.max(1, this.lastContentCapacity - 1)
		return this.scrollLines(direction * pageSize)
	}

	scrollToTop() {
		if (!this.canScroll()) return this.setScrollOffset(0, true)
		return this.setScrollOffset(0, false)
	}

	scrollToBottom() {
		return this.setScrollOffset(this.maxScrollOffset(), true)
	}

	/**
	 * @param {string} line
	 * @param {number} row
	 * @param {number} rows
	 * @param {number} total
	 * @param {number} width
	 */
	applyScrollbar(line, row, rows, total, width) {
		if (width <= 0 || rows <= 0 || total <= rows || this.followTail) return line
		const thumbRows = Math.max(1, Math.round((rows / total) * rows))
		const maxThumbTop = Math.max(0, rows - thumbRows)
		const maxScroll = Math.max(1, total - rows)
		const thumbTop = Math.round((this.scrollOffset / maxScroll) * maxThumbTop)
		if (row < thumbTop || row >= thumbTop + thumbRows) return line
		const baseWidth = Math.max(0, width - 1)
		const clipped = visibleWidth(line) > baseWidth ? sliceByColumn(line, 0, baseWidth, true) : line
		return `${clipped}${" ".repeat(Math.max(0, baseWidth - visibleWidth(clipped)))}${theme.dim("|")}`
	}

	/**
	 * @param {string[]} body
	 * @param {import("../../tui/render-frame.js").RenderSpan[]} spans
	 * @param {import("../../tui/render-frame.js").RenderSourceSpan[]} sourceSpans
	 * @param {import("../../tui/render-frame.js").RenderRegion[]} regions
	 * @param {number} width
	 * @param {number} total
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[], sourceSpans: import("../../tui/render-frame.js").RenderSourceSpan[], regions: import("../../tui/render-frame.js").RenderRegion[] }}
	 */
	decorateFrame(body, spans, sourceSpans, regions, width, total) {
		/** @type {Set<number>} */
		const scrollbarRows = new Set()
		const lines = body.map((line, i) => {
			const decorated = this.applyScrollbar(line, i, body.length, total, width)
			if (decorated !== line) scrollbarRows.add(i)
			return decorated
		})
		const clippedSpans = spans.flatMap((span) => {
			if (!scrollbarRows.has(span.line)) return [span]
			const clipped = clipSpanColumns(span, 0, Math.max(0, width - 1))
			return clipped ? [clipped] : []
		})
		const clippedSourceSpans = sourceSpans.flatMap((span) => {
			if (!scrollbarRows.has(span.line)) return [span]
			const clipped = clipSourceSpanColumns(span, 0, Math.max(0, width - 1))
			return clipped ? [clipped] : []
		})
		const scrollbarSourceSpans = [...scrollbarRows].flatMap((line) => (
			width > 0 ? [{ line, startCol: width - 1, endCol: width, ignore: true, component: this }] : []
		))
		const clippedRegions = regions.flatMap((region) => {
			if (!scrollbarRows.has(region.line)) return [region]
			const clipped = clipRegionColumns(region, 0, Math.max(0, width - 1))
			return clipped ? [clipped] : []
		})
		return { lines, spans: clippedSpans, sourceSpans: clippedSourceSpans.concat(scrollbarSourceSpans), regions: clippedRegions }
	}

	/** @param {number} width */
	renderFrame(width) {
		const source = normalizeRenderFrame(typeof this.transcript.renderIncremental === "function"
			? this.transcript.renderIncremental(width)
			: typeof this.transcript.renderFrame === "function"
				? this.transcript.renderFrame(width)
				: this.transcript.render(width))
		const sourceLines = source.lines
		const requestedMaxLines = Math.floor(this.getMaxLines(width))
		const maxLines = requestedMaxLines === Infinity
			? Infinity
			: Number.isFinite(requestedMaxLines)
				? Math.max(0, requestedMaxLines)
				: 0
		this.lastTotalLines = sourceLines.length
		if (maxLines <= 0) {
			this.lastRenderedHeight = 0
			this.lastContentCapacity = 0
			return { lines: [], spans: [], sourceSpans: [], regions: [] }
		}
		if (sourceLines.length <= maxLines) {
			this.scrollOffset = 0
			this.followTail = true
			this.lastRenderedHeight = sourceLines.length
			this.lastContentCapacity = maxLines
			return this.decorateFrame(sourceLines, source.spans, source.sourceSpans, source.regions, width, sourceLines.length)
		}

		const contentCapacity = Math.max(1, maxLines)
		const maxStart = Math.max(0, sourceLines.length - contentCapacity)
		if (this.followTail) this.scrollOffset = maxStart
		else this.scrollOffset = Math.max(0, Math.min(maxStart, this.scrollOffset))

		const end = Math.min(sourceLines.length, this.scrollOffset + contentCapacity)
		const body = sourceLines.slice(this.scrollOffset, end)
		const spans = sliceSpansByLine(source.spans, this.scrollOffset, end)
		const sourceSpans = sliceSourceSpansByLine(source.sourceSpans, this.scrollOffset, end)
		const regions = sliceRegionsByLine(source.regions, this.scrollOffset, end)
		this.lastRenderedHeight = body.length
		this.lastContentCapacity = contentCapacity
		return this.decorateFrame(body, spans, sourceSpans, regions, width, sourceLines.length)
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
}
