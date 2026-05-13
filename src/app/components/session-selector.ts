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
} from "../../tui/index.ts"
import type { Component, Focusable } from "../../tui/index.ts"
import { theme } from "../theme.ts"

export interface SessionRow {
	/** Stable identifier; passed back via onSelect. */
	value: string
	/** Short id shown on the header row (typically `id.slice(0, 8)`). */
	shortId: string
	/** Optional user-given name. */
	name?: string
	/** True for the row representing the currently-open session. */
	current?: boolean
	/** ISO 8601 timestamp of the first message (any role). */
	firstTimestamp?: string
	/** First message text (newlines stripped). */
	firstText?: string
	/** ISO 8601 timestamp of the most recent user message. */
	lastUserTimestamp?: string
	/** Most recent user message text. */
	lastUserText?: string
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n)
}

/** Compact absolute date "YYYY-MM-DD HH:mm". Falls back to "—" on bad input. */
function formatDate(iso: string | undefined): string {
	if (!iso) return "—"
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return "—"
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function normalizeSingleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
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

class SessionList implements Component, Focusable {
	private rows: SessionRow[]
	private selectedIndex: number
	private maxVisible = 8
	focused = false

	public onSelect?: (row: SessionRow) => void
	public onCancel?: () => void

	constructor(rows: SessionRow[], initialSelectedValue?: string) {
		this.rows = rows
		const idx = initialSelectedValue ? rows.findIndex((r) => r.value === initialSelectedValue) : -1
		this.selectedIndex = idx >= 0 ? idx : 0
	}

	invalidate(): void {}

	setMaxVisible(n: number): void {
		this.maxVisible = Math.max(1, n)
	}

	private renderRow(row: SessionRow, isSelected: boolean, width: number): string[] {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  "
		const cursorWidth = visibleWidth(cursor)
		const labelParts: string[] = []
		labelParts.push(isSelected ? theme.bold(row.shortId) : row.shortId)
		if (row.current) labelParts.push(theme.fg("accent", "*"))
		if (row.name) labelParts.push(theme.fg("warning", row.name))
		const headerLine = cursor + labelParts.join(" ")

		// Indent the two preview lines so the eye groups them under the header.
		const indent = " ".repeat(Math.max(2, cursorWidth))
		const labelWidth = 7 // "first  " / "last   "
		const dateColumnWidth = 16 // "YYYY-MM-DD HH:mm"

		const previewLine = (label: string, ts: string | undefined, text: string | undefined): string => {
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

	render(width: number): string[] {
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

		const lines: string[] = []
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

	handleInput(keyData: string | Buffer): void {
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

export class SessionSelectorComponent extends Container implements Focusable {
	private list: SessionList
	focused = false

	public onSelect?: (row: SessionRow) => void
	public onCancel?: () => void

	constructor(rows: SessionRow[], opts: { initialSelectedValue?: string; title?: string; subtitle?: string } = {}) {
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

	getList(): SessionList {
		return this.list
	}

	handleInput(keyData: string | Buffer): void {
		this.list.handleInput(keyData)
	}
}

interface ShowSelectorCtx {
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component },
	) => void
}

/**
 * Promise wrapper around SessionSelectorComponent — resolves with the chosen
 * session's `value`, or `null` on Esc / cancel.
 */
export async function pickSession(
	ctx: ShowSelectorCtx,
	rows: SessionRow[],
	opts: { initialSelectedValue?: string; title?: string; subtitle?: string } = {},
): Promise<string | null> {
	if (rows.length === 0) return null
	return new Promise<string | null>((resolve) => {
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
