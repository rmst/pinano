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
} from "../../tui/index.ts"
import type { Component, Focusable } from "../../tui/index.ts"
import { theme } from "../theme.ts"

/** Subset of session-manager's entry shape we depend on. Loose-typed because
 * pinano session entries are JSDoc-annotated JS, not TS. */
export interface UserMessageEntry {
	id: string
	parentId: string | null
	text: string
	/** True if this entry is on the path from current leaf to root. */
	onActivePath: boolean
}

/** Visual placement of one entry in the rendered tree. */
interface FlatNode {
	entry: UserMessageEntry
	indent: number // each level = 3 chars
	showConnector: boolean // true when entry has siblings (parent branched)
	isLast: boolean // true when this entry is the last sibling
	gutters: number[] // ancestor levels that still need a │
}

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
 */
function flattenUserTree(entries: UserMessageEntry[]): FlatNode[] {
	const byId = new Map<string, UserMessageEntry>()
	for (const e of entries) byId.set(e.id, e)
	const childrenOf = new Map<string | null, UserMessageEntry[]>()
	for (const e of entries) {
		const arr = childrenOf.get(e.parentId) ?? []
		arr.push(e)
		childrenOf.set(e.parentId, arr)
	}
	for (const arr of childrenOf.values()) arr.sort((a, b) => a.id.localeCompare(b.id))

	// Pre-compute which subtrees contain an active-path entry so we can
	// reorder children: branches containing the active leaf go last (visually
	// closer to the cursor when the picker opens at the bottom of the list).
	const containsActive = new Map<string, boolean>()
	{
		// Iterative post-order over all entries.
		const all: UserMessageEntry[] = []
		const stack = [...(childrenOf.get(null) ?? [])]
		while (stack.length > 0) {
			const e = stack.pop()!
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

	const result: FlatNode[] = []
	type Frame = {
		entry: UserMessageEntry
		indent: number
		showConnector: boolean
		isLast: boolean
		gutters: number[]
	}

	const roots = childrenOf.get(null) ?? []
	const multipleRoots = roots.length > 1
	// Sort: branches containing active leaf go LAST so the picker (which
	// opens at the most recently-active entry) is reached without scrolling.
	const orderedRoots = [...roots].sort(
		(a, b) => Number(containsActive.get(a.id) ?? 0) - Number(containsActive.get(b.id) ?? 0),
	)

	const stack: Frame[] = []
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
		const frame = stack.pop()!
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

class DynamicBorder implements Component {
	private color: (s: string) => string
	constructor(color: (s: string) => string = (s) => theme.fg("border", s)) {
		this.color = color
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))]
	}
}

/**
 * Inner list. Tracks the highlighted index, renders the flattened tree with
 * connectors + active-path markers, and emits select/cancel.
 *
 * Owners attach `onSelect` / `onCancel` (called with `{ value, label }` to
 * match the SelectList callback shape used by the existing test stubs).
 */
class UserMessageList implements Component, Focusable {
	private flat: FlatNode[]
	private selectedIndex: number
	public onSelect?: (item: { value: string; label: string }) => void
	public onCancel?: () => void
	private maxVisible = 12
	focused = false

	constructor(entries: UserMessageEntry[], initialSelectedId?: string) {
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

	invalidate(): void {}

	setMaxVisible(n: number): void {
		this.maxVisible = Math.max(1, n)
	}

	private renderPrefix(node: FlatNode): string {
		// Build the prefix character-by-character so gutters land at exactly
		// the column where their parent's connector was. 3 chars per level.
		const totalChars = node.indent * 3
		const connectorPosition = node.showConnector ? node.indent - 1 : -1
		const out: string[] = []
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

	render(width: number): string[] {
		const lines: string[] = []
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

	handleInput(keyData: string | Buffer): void {
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

export class UserMessageSelectorComponent extends Container implements Focusable {
	private list: UserMessageList
	focused = false

	/**
	 * onSelect / onCancel are exposed on the container itself (not just on the
	 * inner list) so test stubs that drive the picker without a real terminal
	 * can invoke them directly.
	 */
	public onSelect?: (item: { value: string; label: string }) => void
	public onCancel?: () => void

	constructor(
		entries: UserMessageEntry[],
		opts: { initialSelectedId?: string; title?: string; subtitle?: string } = {},
	) {
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

	getList(): UserMessageList {
		return this.list
	}

	handleInput(keyData: string | Buffer): void {
		this.list.handleInput(keyData)
	}
}

export interface PickRewindOptions {
	initialSelectedId?: string
	title?: string
	subtitle?: string
}

interface ShowSelectorCtx {
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component },
	) => void
}

/**
 * Promise wrapper around UserMessageSelectorComponent — resolves with the
 * selected user-message id, or `null` on Esc / cancel.
 */
export async function pickRewindMessage(
	ctx: ShowSelectorCtx,
	entries: UserMessageEntry[],
	opts: PickRewindOptions = {},
): Promise<string | null> {
	if (entries.length === 0) return null

	return new Promise<string | null>((resolve) => {
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
