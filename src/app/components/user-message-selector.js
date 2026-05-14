// Rewind / fork picker — tree-aware port of pi-coding-agent's
// UserMessageSelectorComponent + TreeSelectorComponent.
//
// We show the *user-message tree* (one entry per user prompt, branching
// reflected with ├─/└─/│ connectors). Pi's full TreeSelectorComponent shows
// every entry — assistant turns, tool results, custom messages — which is
// noisy when all you want to do is rewind to something you typed. Pinano
// trims to user messages only.
//
// Branching visualization is the headline feature: every time you've
// rewound, you've created sibling user messages under a common ancestor.
// Without the tree connectors there's no way to tell apart "I asked the
// same thing twice" from "I asked something, rewound, asked something
// else." With them you can see the shape of the conversation history at
// a glance and choose the right point to rewind to.
//
// Renders full-width in place of the editor (pi-style "showSelector" pattern,
// not a centered modal overlay) so the user sees as much of the conversation
// as possible while picking.

import {
	Container,
	Spacer,
	Text,
	getKeybindings,
	truncateToWidth,
} from "../../tui/index.js"
import { theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").Component} Component */
/** @typedef {import("../../tui/index.js").Focusable} Focusable */

/**
 * Subset of session-manager's entry shape we depend on. Loose-typed because
 * pinano session entries are JSDoc-annotated JS, not TS.
 *
 * @typedef {object} UserMessageEntry
 * @property {string} id
 * @property {string | null} parentId
 * @property {string} text
 * @property {boolean} onActivePath True if this entry is on the path from current leaf to root.
 */

/**
 * Visual placement of one entry in the rendered tree.
 *
 * @typedef {object} FlatNode
 * @property {UserMessageEntry} entry
 * @property {number} indent each level = 3 chars
 * @property {boolean} showConnector true when entry has siblings (parent branched)
 * @property {boolean} isLast true when this entry is the last sibling
 * @property {number[]} gutters ancestor levels that still need a │
 */

/**
 * Build the user-message tree, then flatten it into the order we want to
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
 * @param {UserMessageEntry[]} entries
 * @returns {FlatNode[]}
 */
function flattenUserTree(entries) {
	/** @type {Map<string, UserMessageEntry>} */
	const byId = new Map()
	for (const e of entries) byId.set(e.id, e)
	/** @type {Map<string | null, UserMessageEntry[]>} */
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
		/** @type {UserMessageEntry[]} */
		const all = []
		const stack = [...(childrenOf.get(null) ?? [])]
		while (stack.length > 0) {
			const e = /** @type {UserMessageEntry} */ (stack.pop())
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
	 * @property {UserMessageEntry} entry
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
class UserMessageList {
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
	 * @param {UserMessageEntry[]} entries
	 * @param {string} [initialSelectedId]
	 */
	constructor(entries, initialSelectedId) {
		this.flat = flattenUserTree(entries)
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

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		/** @type {string[]} */
		const lines = []
		if (this.flat.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"))
			return lines
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
			const cursor = isSelected ? theme.fg("accent", "› ") : "  "
			const prefix = this.renderPrefix(node)
			// Active-path bullet — distinguishes the current branch's user
			// messages from siblings on rewound (discarded) branches.
			const activeMarker = node.entry.onActivePath ? theme.fg("accent", "• ") : "  "

			const normalized = node.entry.text.replace(/\n/g, " ").trim()
			const used = 2 + node.indent * 3 + 2 // cursor + prefix + activeMarker
			const maxText = Math.max(1, width - used)
			const truncated = truncateToWidth(normalized, maxText)
			// Discarded entries (not on active path) dim slightly so the
			// active branch reads as the "live" thread at a glance.
			const styled = node.entry.onActivePath
				? isSelected ? theme.bold(truncated) : truncated
				: theme.fg("dim", truncated)
			lines.push(cursor + prefix + activeMarker + styled)
		}

		// Position indicator + scroll-availability hint.
		if (startIndex > 0 || endIndex < this.flat.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flat.length})`))
		}
		return lines
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		const data = typeof keyData === "string" ? keyData : keyData.toString("binary")
		const kb = getKeybindings()
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex =
				this.selectedIndex === 0 ? this.flat.length - 1 : this.selectedIndex - 1
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex =
				this.selectedIndex === this.flat.length - 1 ? 0 : this.selectedIndex + 1
		} else if (kb.matches(data, "tui.select.confirm")) {
			const sel = this.flat[this.selectedIndex]
			if (sel) {
				this.onSelect?.({
					value: sel.entry.id,
					label: sel.entry.text.replace(/\n/g, " ").trim(),
				})
			}
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.()
		}
	}
}

/** @implements {Focusable} */
export class UserMessageSelectorComponent extends Container {
	/** @type {UserMessageList} */
	list
	focused = false

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
	 * @param {UserMessageEntry[]} entries
	 * @param {{ initialSelectedId?: string, title?: string, subtitle?: string }} [opts]
	 */
	constructor(entries, opts = {}) {
		super()
		this.addChild(new Spacer(1))
		this.addChild(new Text(theme.bold(opts.title ?? "Rewind to a previous message"), 1, 0))
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					opts.subtitle ?? "Pick a past user message. " +
						theme.fg("accent", "• ") +
						theme.fg("muted", "= still on active branch."),
				),
				1,
				0,
			),
		)
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())
		this.addChild(new Spacer(1))

		this.list = new UserMessageList(entries, opts.initialSelectedId)
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

	/** @returns {UserMessageList} */
	getList() {
		return this.list
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		this.list.handleInput(keyData)
	}
}

/**
 * @typedef {object} PickRewindOptions
 * @property {string} [initialSelectedId]
 * @property {string} [title]
 * @property {string} [subtitle]
 */

/**
 * @typedef {object} ShowSelectorCtx
 * @property {(create: (done: () => void) => { component: Component, focus: Component }) => void} showSelector
 */

/**
 * Promise wrapper around UserMessageSelectorComponent — resolves with the
 * selected user-message id, or `null` on Esc / cancel.
 *
 * @param {ShowSelectorCtx} ctx
 * @param {UserMessageEntry[]} entries
 * @param {PickRewindOptions} [opts]
 * @returns {Promise<string | null>}
 */
export async function pickRewindMessage(ctx, entries, opts = {}) {
	if (entries.length === 0) return null

	return new Promise((resolve) => {
		ctx.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(entries, {
				initialSelectedId: opts.initialSelectedId,
				title: opts.title,
				subtitle: opts.subtitle,
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
		})
	})
}
