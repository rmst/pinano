// Resume picker — full-width inline component, three lines per session:
// id row, first message line, last user message line.
//
// Replaces the centred SelectList overlay we used to ship for `/resume`. The
// overlay was too cramped to show useful context per session; this layout
// trades vertical density for "which conversation is this, again?" at a
// glance.
//
// Renders in place of the editor via the `showSelector` swap (the same
// pi-style mechanism `user-message-selector` uses). See `chat-mode.ts`.

import {
	Container,
	Spacer,
	Text,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "../../tui/index.js"
import { theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").Component} Component */
/** @typedef {import("../../tui/index.js").Focusable} Focusable */

/**
 * @typedef {object} SessionRow
 * @property {string} value Stable identifier; passed back via onSelect.
 * @property {string} shortId Short id shown on the header row (typically `id.slice(0, 8)`).
 * @property {string} [name] Optional user-given name.
 * @property {boolean} [current] True for the row representing the currently-open session.
 * @property {string} [firstTimestamp] ISO 8601 timestamp of the first message (any role).
 * @property {string} [firstText] First message text (newlines stripped).
 * @property {string} [lastUserTimestamp] ISO 8601 timestamp of the most recent user message.
 * @property {string} [lastUserText] Most recent user message text.
 */

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
	return n < 10 ? `0${n}` : String(n)
}

/**
 * Compact absolute date "YYYY-MM-DD HH:mm". Falls back to "—" on bad input.
 *
 * @param {string | undefined} iso
 * @returns {string}
 */
function formatDate(iso) {
	if (!iso) return "—"
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return "—"
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeSingleLine(text) {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
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
 * @implements {Component}
 * @implements {Focusable}
 */
class SessionList {
	/** @type {SessionRow[]} */
	rows
	/** @type {number} */
	selectedIndex
	maxVisible = 8
	focused = false

	/** @type {((row: SessionRow) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/**
	 * @param {SessionRow[]} rows
	 * @param {string} [initialSelectedValue]
	 */
	constructor(rows, initialSelectedValue) {
		this.rows = rows
		const idx = initialSelectedValue ? rows.findIndex((r) => r.value === initialSelectedValue) : -1
		this.selectedIndex = idx >= 0 ? idx : 0
	}

	invalidate() {}

	/** @param {number} n */
	setMaxVisible(n) {
		this.maxVisible = Math.max(1, n)
	}

	/**
	 * @param {SessionRow} row
	 * @param {boolean} isSelected
	 * @param {number} width
	 * @returns {string[]}
	 */
	renderRow(row, isSelected, width) {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  "
		const cursorWidth = visibleWidth(cursor)
		/** @type {string[]} */
		const labelParts = []
		labelParts.push(isSelected ? theme.bold(row.shortId) : row.shortId)
		if (row.current) labelParts.push(theme.fg("accent", "*"))
		if (row.name) labelParts.push(theme.fg("warning", row.name))
		const headerLine = cursor + labelParts.join(" ")

		// Indent the two preview lines so the eye groups them under the header.
		const indent = " ".repeat(Math.max(2, cursorWidth))
		const labelWidth = 7 // "first  " / "last   "
		const dateColumnWidth = 16 // "YYYY-MM-DD HH:mm"

		/**
		 * @param {string} label
		 * @param {string | undefined} ts
		 * @param {string | undefined} text
		 * @returns {string}
		 */
		const previewLine = (label, ts, text) => {
			const labelPad = (label + " ".repeat(labelWidth)).slice(0, labelWidth)
			const dateStr = formatDate(ts)
			const datePad = dateStr + " ".repeat(Math.max(0, dateColumnWidth - visibleWidth(dateStr)))
			const prefix = indent + theme.fg("dim", labelPad) + theme.fg("dim", datePad) + " "
			const remaining = Math.max(1, width - visibleWidth(prefix) - 1)
			const snippet = text ? normalizeSingleLine(text) : theme.fg("dim", "(none)")
			return prefix + truncateToWidth(snippet, remaining, "…")
		}

		const firstLine = previewLine("first", row.firstTimestamp, row.firstText)
		// Skip the "last" line entirely if it duplicates the first message
		// (single-turn sessions). Saves a row without losing information.
		const sameAsFirst = row.lastUserTimestamp === row.firstTimestamp
		if (sameAsFirst || !row.lastUserTimestamp) {
			return [headerLine, firstLine]
		}
		const lastLine = previewLine("last", row.lastUserTimestamp, row.lastUserText)
		return [headerLine, firstLine, lastLine]
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		if (this.rows.length === 0) {
			return [theme.fg("muted", "  No sessions for this cwd.")]
		}

		// Each row's height is variable (2 or 3 lines). Compute lengths so we
		// can fit as many entries as possible while keeping the selected row
		// visible.
		const heights = this.rows.map((r) => (r.lastUserTimestamp && r.lastUserTimestamp !== r.firstTimestamp ? 3 : 2))

		// Pick a window centered on the selection. Walk outward from
		// `selectedIndex` until the maxVisible budget is exhausted.
		let startIndex = this.selectedIndex
		let endIndex = this.selectedIndex + 1
		let used = heights[this.selectedIndex] ?? 2
		const budget = Math.max(heights[this.selectedIndex] ?? 2, this.maxVisible * 3)
		while ((startIndex > 0 || endIndex < this.rows.length) && used < budget) {
			// Prefer to add below first (newer-style scrolling), then above.
			if (endIndex < this.rows.length) {
				const h = heights[endIndex]
				if (used + h > budget) break
				used += h
				endIndex++
				continue
			}
			if (startIndex > 0) {
				const h = heights[startIndex - 1]
				if (used + h > budget) break
				used += h
				startIndex--
				continue
			}
			break
		}

		/** @type {string[]} */
		const lines = []
		for (let i = startIndex; i < endIndex; i++) {
			const row = this.rows[i]
			const rowLines = this.renderRow(row, i === this.selectedIndex, width)
			for (const l of rowLines) lines.push(l)
		}

		// Scroll indicator + position counter.
		if (startIndex > 0 || endIndex < this.rows.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.rows.length})`))
		}
		return lines
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		const data = typeof keyData === "string" ? keyData : keyData.toString("binary")
		const kb = getKeybindings()
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.rows.length - 1 : this.selectedIndex - 1
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.rows.length - 1 ? 0 : this.selectedIndex + 1
		} else if (kb.matches(data, "tui.select.confirm")) {
			const sel = this.rows[this.selectedIndex]
			if (sel) this.onSelect?.(sel)
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.()
		}
	}
}

/** @implements {Focusable} */
export class SessionSelectorComponent extends Container {
	/** @type {SessionList} */
	list
	focused = false

	/** @type {((row: SessionRow) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/**
	 * @param {SessionRow[]} rows
	 * @param {{ initialSelectedValue?: string, title?: string, subtitle?: string }} [opts]
	 */
	constructor(rows, opts = {}) {
		super()
		this.addChild(new Spacer(1))
		this.addChild(new Text(theme.bold(opts.title ?? "Resume session"), 1, 0))
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					opts.subtitle ??
						`${theme.fg("accent", "*")} marks the current session. ↑↓ to navigate, Enter to resume, Esc to cancel.`,
				),
				1,
				0,
			),
		)
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())
		this.addChild(new Spacer(1))

		this.list = new SessionList(rows, opts.initialSelectedValue)
		this.list.onSelect = (row) => this.onSelect?.(row)
		this.list.onCancel = () => this.onCancel?.()
		this.addChild(this.list)

		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())

		if (rows.length === 0) {
			setTimeout(() => this.onCancel?.(), 0)
		}
	}

	/** @returns {SessionList} */
	getList() {
		return this.list
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		this.list.handleInput(keyData)
	}
}

/**
 * @typedef {object} ShowSelectorCtx
 * @property {(create: (done: () => void) => { component: Component, focus: Component }) => void} showSelector
 */

/**
 * Promise wrapper around SessionSelectorComponent — resolves with the chosen
 * session's `value`, or `null` on Esc / cancel.
 *
 * @param {ShowSelectorCtx} ctx
 * @param {SessionRow[]} rows
 * @param {{ initialSelectedValue?: string, title?: string, subtitle?: string }} [opts]
 * @returns {Promise<string | null>}
 */
export async function pickSession(ctx, rows, opts = {}) {
	if (rows.length === 0) return null
	return new Promise((resolve) => {
		ctx.showSelector((done) => {
			const selector = new SessionSelectorComponent(rows, opts)
			selector.onSelect = (row) => {
				done()
				resolve(row.value)
			}
			selector.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: selector, focus: selector.getList() }
		})
	})
}
