// Scrollable read-only text modal for informational slash commands.

import { matchesKey, visibleWidth, wrapTextWithAnsi } from "../../tui/index.js"
import { sliceByColumn } from "../../tui/utils.js"
import { theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").TUI} TUI */

function fitToWidth(text, width) {
	if (width <= 0) return ""
	const clipped = visibleWidth(text) > width ? sliceByColumn(text, 0, width, true) : text
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
}

function border(width) {
	return theme.fg("border", "─".repeat(Math.max(1, width)))
}

function scrollbarCell(row, rows, total, scroll) {
	if (total <= rows) return ""
	const thumbRows = Math.max(1, Math.round((rows / total) * rows))
	const maxThumbTop = Math.max(0, rows - thumbRows)
	const maxScroll = Math.max(1, total - rows)
	const thumbTop = Math.round((scroll / maxScroll) * maxThumbTop)
	return row >= thumbTop && row < thumbTop + thumbRows
		? theme.fg("accent", "█")
		: theme.fg("border", "│")
}

export class TextModal {
	constructor(title, body, opts = {}) {
		this.title = title
		this.body = body
		this.subtitle = opts.subtitle ?? "Esc/q closes · ↑/↓ scroll · PgUp/PgDn page · Home/End jump"
		this.getHeight = opts.getHeight ?? (() => process.stdout.rows || Number(process.env.LINES) || 24)
		this.scroll = 0
		this.onClose = undefined
		this.focused = false
		this.lastBodyRows = 1
		this.cachedBody = undefined
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}

	invalidate() {
		this.cachedBody = undefined
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}

	bodyLines(width) {
		if (this.cachedBody === this.body && this.cachedWidth === width && this.cachedLines) return this.cachedLines
		const contentWidth = Math.max(1, width)
		const lines = []
		for (const raw of this.body.split("\n")) {
			if (raw === "") {
				lines.push("")
				continue
			}
			for (const line of wrapTextWithAnsi(raw, contentWidth)) lines.push(line)
		}
		this.cachedBody = this.body
		this.cachedWidth = width
		this.cachedLines = lines
		return lines
	}

	handleInput(data) {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
			this.onClose?.()
			return
		}
		const page = Math.max(1, this.lastBodyRows - 1)
		if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1)
		else if (matchesKey(data, "down")) this.scroll += 1
		else if (matchesKey(data, "pageup")) this.scroll = Math.max(0, this.scroll - page)
		else if (matchesKey(data, "pagedown")) this.scroll += page
		else if (matchesKey(data, "home")) this.scroll = 0
		else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER
	}

	render(width) {
		const modalWidth = Math.max(20, width)
		const modalHeight = Math.max(8, this.getHeight())
		const title = ` ${this.title} `
		const header = theme.fg("border", "─") + theme.bold(fitToWidth(title, Math.max(1, modalWidth - 1)))
		const top = fitToWidth(header, modalWidth)
		const bodyRows = Math.max(1, modalHeight - 5)
		const bodyHasScroll = this.bodyLines(Math.max(1, modalWidth - 3)).length > bodyRows
		const gutterWidth = bodyHasScroll ? 1 : 0
		const contentWidth = Math.max(1, modalWidth - 3 - gutterWidth)
		const all = this.bodyLines(contentWidth)
		this.lastBodyRows = bodyRows
		const maxScroll = Math.max(0, all.length - bodyRows)
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll))
		const shown = all.slice(this.scroll, this.scroll + bodyRows)
		while (shown.length < bodyRows) shown.push("")
		const lines = [
			top,
			fitToWidth(theme.dim(` ${this.subtitle}`), modalWidth),
			fitToWidth(border(modalWidth), modalWidth),
		]
		for (let i = 0; i < shown.length; i++) {
			const thumb = scrollbarCell(i, bodyRows, all.length, this.scroll)
			lines.push(fitToWidth(`  ${fitToWidth(shown[i], contentWidth)} ${thumb}`, modalWidth))
		}
		const pos = all.length > bodyRows ? ` ${this.scroll + 1}-${Math.min(all.length, this.scroll + bodyRows)} / ${all.length}` : ""
		lines.push(fitToWidth(border(modalWidth), modalWidth))
		lines.push(fitToWidth(theme.dim(`${pos}  Esc/q close`), modalWidth))
		while (lines.length < modalHeight) lines.push(" ".repeat(modalWidth))
		return lines.slice(0, modalHeight).map((line) => fitToWidth(line, modalWidth))
	}
}

export function showTextModal(tui, title, body, opts = {}) {
	return new Promise((resolve) => {
		const modal = new TextModal(title, body, { ...opts, getHeight: () => tui.terminal.rows })
		const handle = tui.showOverlay(modal, {
			width: opts.width ?? "100%",
			maxHeight: opts.maxHeight ?? "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
			margin: 0,
		})
		modal.onClose = () => {
			handle.hide()
			resolve()
		}
	})
}
