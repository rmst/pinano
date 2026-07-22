// Rewind picker — tree-aware port of pi-coding-agent's
// HistorySelectorComponent + TreeSelectorComponent.
//
// We show a compact history tree: user prompts as rewind targets, plus branch
// tips as leaf targets. Pi's full TreeSelectorComponent shows every entry —
// assistant turns, tool results, custom messages — which is noisy when all you
// want is either to rewind to something you typed or continue an existing
// branch tip.
//
// Branching visualization is the headline feature: every time you've
// rewound, you've created sibling user messages under a common ancestor.
// Without the tree connectors there's no way to tell apart "I asked the
// same thing twice" from "I asked something, rewound, asked something
// else." With them you can see the shape of the conversation history at
// a glance and choose the right point to rewind to.
//
// Opens as a full-screen selector so the user sees as much of the
// conversation tree as the terminal can show while picking.

import {
	Container,
	MouseWheelDeltaTracker,
	Spacer,
	Text,
	clickableRowSpan,
	getKeybindings,
	nextSelectionIndex,
	offsetSpans,
	truncateToWidth,
	visibleWidth,
} from "../../tui/index.js"
import { sliceByColumn } from "../../tui/utils.js"
import { theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").Component} Component */
/** @typedef {import("../../tui/index.js").Focusable} Focusable */

/**
 * Subset of session-manager's entry shape we depend on. Loose-typed because
 * pinano session entries are JSDoc-annotated JS, not TS.
 *
 * @typedef {object} HistoryEntry
 * @property {"message" | "leaf"} [kind]
 * @property {string} id
 * @property {string | null} parentId
 * @property {string} text
 * @property {boolean} onActivePath True if this prompt is on the path from current leaf to root.
 * @property {boolean} [isLeaf]
 * @property {boolean} [active]
 */

/**
 * Visual placement of one entry in the rendered tree.
 *
 * @typedef {object} FlatNode
 * @property {HistoryEntry} entry
 * @property {number} indent each level = 3 chars
 * @property {boolean} showConnector true when entry has siblings (parent branched)
 * @property {boolean} isLast true when this entry is the last sibling
 * @property {number[]} gutters ancestor levels that still need a │
 */

/**
 * Build the compact history tree, then flatten it into the order we want to
 * render: depth-first, branches containing the active leaf shown last (so
 * the most recent / "still alive" branch is closest to the cursor when
 * the picker opens).
 *
 * Indent rules mirror pi:
 * - Single-child chains stay at the same indent (a linear conversation
 *   renders as a flat list, no useless rightward drift).
 * - When a parent has multiple children, its children indent +1.
 * - Roots start at 0; if there are multiple roots, all roots get +1 so
 *   the implied "shared (empty) ancestor" is visually a branching point.
 *
 * @param {HistoryEntry[]} entries
 * @returns {FlatNode[]}
 */
function fitToWidth(text, width) {
	if (width <= 0) return ""
	const clipped = visibleWidth(text) > width ? sliceByColumn(text, 0, width, true) : text
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
}

function flattenHistoryTree(entries) {
	/** @type {Map<string, HistoryEntry>} */
	const byId = new Map()
	for (const e of entries) byId.set(e.id, e)
	/** @type {Map<string | null, HistoryEntry[]>} */
	const childrenOf = new Map()
	for (const e of entries) {
		const arr = childrenOf.get(e.parentId) ?? []
		arr.push(e)
		childrenOf.set(e.parentId, arr)
	}
	for (const arr of childrenOf.values()) arr.sort((a, b) => a.id.localeCompare(b.id))

	// Pre-compute which subtrees contain an active-path entry so we can
	// reorder children: branches containing the active leaf go last (visually
	// closer to the cursor when the picker opens at the bottom of the list).
	/** @type {Map<string, boolean>} */
	const containsActive = new Map()
	{
		// Iterative post-order over all entries.
		/** @type {HistoryEntry[]} */
		const all = []
		const stack = [...(childrenOf.get(null) ?? [])]
		while (stack.length > 0) {
			const e = /** @type {HistoryEntry} */ (stack.pop())
			all.push(e)
			for (const c of childrenOf.get(e.id) ?? []) stack.push(c)
		}
		for (let i = all.length - 1; i >= 0; i--) {
			const e = all[i]
			let has = e.onActivePath
			for (const c of childrenOf.get(e.id) ?? []) {
				if (containsActive.get(c.id)) has = true
			}
			containsActive.set(e.id, has)
		}
	}

	/** @type {FlatNode[]} */
	const result = []
	/**
	 * @typedef {object} Frame
	 * @property {HistoryEntry} entry
	 * @property {number} indent
	 * @property {boolean} showConnector
	 * @property {boolean} isLast
	 * @property {number[]} gutters
	 */

	const roots = childrenOf.get(null) ?? []
	const multipleRoots = roots.length > 1
	// Sort: branches containing active leaf go LAST so the picker (which
	// opens at the most recently-active entry) is reached without scrolling.
	const orderedRoots = [...roots].sort(
		(a, b) => Number(containsActive.get(a.id) ?? 0) - Number(containsActive.get(b.id) ?? 0),
	)

	/** @type {Frame[]} */
	const stack = []
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const r = orderedRoots[i]
		stack.push({
			entry: r,
			indent: multipleRoots ? 1 : 0,
			showConnector: multipleRoots,
			isLast: i === orderedRoots.length - 1,
			gutters: [],
		})
	}

	while (stack.length > 0) {
		const frame = /** @type {Frame} */ (stack.pop())
		result.push({
			entry: frame.entry,
			indent: frame.indent,
			showConnector: frame.showConnector,
			isLast: frame.isLast,
			gutters: frame.gutters,
		})

		const children = childrenOf.get(frame.entry.id) ?? []
		const orderedChildren = [...children].sort(
			(a, b) => Number(containsActive.get(a.id) ?? 0) - Number(containsActive.get(b.id) ?? 0),
		)
		const branches = orderedChildren.length > 1
		const childIndent = branches ? frame.indent + 1 : frame.indent

		// Carry parent's gutters forward; if THIS entry showed a connector AND
		// it wasn't the last sibling at its level, descendants need a │ at
		// the parent's indent so the tree visually closes correctly.
		const childGutters = frame.showConnector && !frame.isLast
			? [...frame.gutters, Math.max(0, frame.indent - 1)]
			: frame.gutters

		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			const child = orderedChildren[i]
			stack.push({
				entry: child,
				indent: childIndent,
				showConnector: branches,
				isLast: i === orderedChildren.length - 1,
				gutters: childGutters,
			})
		}
	}

	return result
}

/** @implements {Component} */
class DynamicBorder {
	/** @type {(s: string) => string} */
	color

	/** @param {(s: string) => string} [color] */
	constructor(color = (s) => theme.fg("border", s)) {
		this.color = color
	}
	invalidate() {}
	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		return [this.color("─".repeat(Math.max(1, width)))]
	}
}

/**
 * Inner list. Tracks the highlighted index, renders the flattened tree with
 * connectors + active-path markers, and emits select/cancel.
 *
 * Owners attach `onSelect` / `onCancel` (called with `{ value, label }` to
 * match the SelectList callback shape used by the existing test stubs).
 *
 * @implements {Component}
 * @implements {Focusable}
 */
class HistoryList {
	/** @type {FlatNode[]} */
	flat
	/** @type {number} */
	selectedIndex
	/** @type {((item: { value: string, label: string }) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel
	maxVisible = 12
	focused = false

	/**
	 * @param {HistoryEntry[]} entries
	 * @param {string} [initialSelectedId]
	 */
	constructor(entries, initialSelectedId) {
		this.flat = flattenHistoryTree(entries)
		this.wheelDeltas = new MouseWheelDeltaTracker()
		// Default cursor: the most-recent active-path entry — usually the
		// thing the user wants to rewind near.
		const initialIdx = initialSelectedId
			? this.flat.findIndex((n) => n.entry.id === initialSelectedId)
			: -1
		const lastActiveIdx = (() => {
			for (let i = this.flat.length - 1; i >= 0; i--) {
				if (this.flat[i].entry.onActivePath) return i
			}
			return this.flat.length - 1
		})()
		this.selectedIndex = initialIdx >= 0 ? initialIdx : Math.max(0, lastActiveIdx)
	}

	invalidate() {}

	/** @param {number} n */
	setMaxVisible(n) {
		this.maxVisible = Math.max(1, n)
	}

	/**
	 * @param {number} delta
	 * @param {{ wrap?: boolean }} [options]
	 * @returns {boolean}
	 */
	moveSelection(delta, options = {}) {
		const next = nextSelectionIndex(this.selectedIndex, this.flat.length, delta, { wrap: options.wrap !== false })
		if (next === this.selectedIndex) return false
		this.selectedIndex = next
		return true
	}

	/**
	 * @param {FlatNode} node
	 * @returns {string}
	 */
	renderPrefix(node) {
		// Build the prefix character-by-character so gutters land at exactly
		// the column where their parent's connector was. 3 chars per level.
		const totalChars = node.indent * 3
		const connectorPosition = node.showConnector ? node.indent - 1 : -1
		/** @type {string[]} */
		const out = []
		for (let i = 0; i < totalChars; i++) {
			const level = Math.floor(i / 3)
			const posInLevel = i % 3
			const hasGutter = node.gutters.includes(level)
			if (hasGutter && posInLevel === 0) {
				out.push("│")
			} else if (level === connectorPosition) {
				if (posInLevel === 0) out.push(node.isLast ? "└" : "├")
				else if (posInLevel === 1) out.push("─")
				else out.push(" ")
			} else {
				out.push(" ")
			}
		}
		return theme.fg("borderMuted", out.join(""))
	}

	/** @param {number} index */
	activateIndex(index) {
		const sel = this.flat[index]
		if (!sel) return
		this.selectedIndex = Math.max(0, Math.min(index, this.flat.length - 1))
		this.onSelect?.({
			value: sel.entry.id,
			label: sel.entry.text.replace(/\n/g, " ").trim(),
		})
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[] }}
	 */
	renderFrame(width) {
		/** @type {string[]} */
		const lines = []
		/** @type {import("../../tui/render-frame.js").RenderSpan[]} */
		const spans = []
		if (this.flat.length === 0) {
			lines.push(theme.fg("muted", "  No rewind targets found"))
			return { lines, spans }
		}

		// Vertical scrolling — keep the cursor centred when possible.
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.flat.length - this.maxVisible,
			),
		)
		const endIndex = Math.min(startIndex + this.maxVisible, this.flat.length)

		for (let i = startIndex; i < endIndex; i++) {
			const node = this.flat[i]
			const isSelected = i === this.selectedIndex
			const cursor = isSelected ? theme.fg("chromeAccent", "› ") : "  "
			const prefix = this.renderPrefix(node)
			// Active-path bullet distinguishes the current branch's prompts from
			// siblings on rewound branches. Leaf rows use a diamond so branch tips
			// read as navigable endpoints, not prompts to replay.
			const activeMarker = node.entry.kind === "leaf"
				? node.entry.active ? theme.fg("chromeAccent", "◆ ") : theme.fg("muted", "◇ ")
				: node.entry.onActivePath ? theme.fg("chromeAccent", "• ") : "  "

			const normalized = node.entry.text.replace(/\n/g, " ").trim()
			const used = 2 + node.indent * 3 + 2 // cursor + prefix + activeMarker
			const maxText = Math.max(1, width - used)
			const truncated = truncateToWidth(normalized, maxText)
			// Discarded entries (not on active path) dim slightly so the
			// active branch reads as the "live" thread at a glance.
			const current = node.entry.onActivePath || node.entry.active
			const styled = current
				? isSelected ? theme.bold(truncated) : truncated
				: theme.fg("dim", truncated)
			const line = cursor + prefix + activeMarker + styled
			const lineIndex = lines.length
			lines.push(line)
			const span = clickableRowSpan({
				line: lineIndex,
				text: line,
				width,
				component: this,
				id: `history-selector.item.${node.entry.id}`,
				label: normalized,
				metadata: { node, index: i },
				onClick: () => this.activateIndex(i),
			})
			if (span) spans.push(span)
		}

		// Position indicator + scroll-availability hint.
		if (startIndex > 0 || endIndex < this.flat.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flat.length})`))
		}
		return { lines, spans }
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		return this.renderFrame(width).lines
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		const data = typeof keyData === "string" ? keyData : keyData.toString("binary")
		const kb = getKeybindings()
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1)
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1)
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.activateIndex(this.selectedIndex)
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.()
		}
	}

	/** @param {import("../../tui/tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		const delta = this.wheelDeltas.deltaFromEvent(event)
		if (delta === 0) return { consume: false }
		this.moveSelection(delta, { wrap: false })
		return { consume: true }
	}
}

/** @implements {Focusable} */
export class HistorySelectorComponent extends Container {
	/** @type {HistoryList} */
	list
	focused = false
	/** @type {(() => number) | undefined} */
	getHeight

	/**
	 * onSelect / onCancel are exposed on the container itself (not just on the
	 * inner list) so test stubs that drive the picker without a real terminal
	 * can invoke them directly.
	 *
	 * @type {((item: { value: string, label: string }) => void) | undefined}
	 */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/**
	 * @param {HistoryEntry[]} entries
	 * @param {{ initialSelectedId?: string, title?: string, subtitle?: string, getHeight?: () => number }} [opts]
	 */
	constructor(entries, opts = {}) {
		super()
		this.getHeight = opts.getHeight
		this.addChild(new Spacer(1))
		this.addChild(new Text(theme.bold(opts.title ?? "Rewind or switch branches"), 1, 0))
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					opts.subtitle ?? "Pick a prompt to rewind before, or a " +
						theme.fg("muted", "◇ ") +
						theme.fg("muted", "branch tip to continue from."),
				),
				1,
				0,
			),
		)
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())
		this.addChild(new Spacer(1))

		this.list = new HistoryList(entries, opts.initialSelectedId)
		this.list.onSelect = (item) => this.onSelect?.(item)
		this.list.onCancel = () => this.onCancel?.()
		this.addChild(this.list)

		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())

		// Empty list — close on the next tick so the caller doesn't need a
		// special branch for it.
		if (entries.length === 0) {
			setTimeout(() => this.onCancel?.(), 0)
		}
	}

	/** @returns {HistoryList} */
	getList() {
		return this.list
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../../tui/render-frame.js").RenderSpan[] }}
	 */
	renderFrame(width) {
		const desiredHeight = Math.floor(this.getHeight?.() ?? 0)
		if (desiredHeight > 0) {
			const fixedRows = 8
			const listRows = Math.max(1, desiredHeight - fixedRows)
			const needsIndicator = this.list.flat.length > listRows
			this.list.setMaxVisible(Math.max(1, listRows - (needsIndicator ? 1 : 0)))
		}

		const childFrame = this.renderChildrenIncremental(width)
		let lines = childFrame.lines
		let spans = childFrame.spans
		if (desiredHeight > 0) {
			if (lines.length < desiredHeight) {
				const insertAt = Math.max(0, lines.length - 1)
				const insertedRows = desiredHeight - lines.length
				lines = [
					...lines.slice(0, insertAt),
					...Array.from({ length: insertedRows }, () => ""),
					...lines.slice(insertAt),
				]
				spans = spans.flatMap((span) => span.line >= insertAt ? offsetSpans([span], insertedRows) : [span])
			}
			lines = lines.slice(0, desiredHeight)
			spans = spans.filter((span) => span.line < desiredHeight)
		}
		return { lines: lines.map((line) => fitToWidth(line, width)), spans }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		this.list.handleInput(keyData)
	}

	/** @param {import("../../tui/tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		return this.list.handleMouseEvent(event)
	}
}

/**
 * @typedef {object} PickHistoryOptions
 * @property {string} [initialSelectedId]
 * @property {string} [title]
 * @property {string} [subtitle]
 */

/**
 * @typedef {object} ShowSelectorCtx
 * @property {(create: (done: () => void) => { component: Component, focus: Component }, opts?: { fullscreen?: boolean }) => void} showSelector
 * @property {{ terminal?: { rows?: number } }} [tui]
 */

/**
 * Promise wrapper around HistorySelectorComponent — resolves with the
 * selected history target id, or `null` on Esc / cancel.
 *
 * @param {ShowSelectorCtx} ctx
 * @param {HistoryEntry[]} entries
 * @param {PickHistoryOptions} [opts]
 * @returns {Promise<string | null>}
 */
export async function pickHistoryTarget(ctx, entries, opts = {}) {
	if (entries.length === 0) return null

	return new Promise((resolve) => {
		ctx.showSelector((done) => {
			const selector = new HistorySelectorComponent(entries, {
				initialSelectedId: opts.initialSelectedId,
				title: opts.title,
				subtitle: opts.subtitle,
				getHeight: () => ctx.tui?.terminal?.rows ?? process.stdout.rows ?? Number(process.env.LINES) ?? 24,
			})
			selector.onSelect = (item) => {
				done()
				resolve(item.value)
			}
			selector.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: selector, focus: selector.getList() }
		}, { fullscreen: true })
	})
}
