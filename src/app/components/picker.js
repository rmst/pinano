// Promise-wrapped SelectList overlay with a small modal frame.
//
// Resolves with the chosen item.value, or null on Esc/cancel.

import { SelectList, truncateToWidth, visibleWidth } from "../../tui/index.js"
import { editorTheme, theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").SelectItem} SelectItem */
/** @typedef {import("../../tui/index.js").TUI} TUI */

/**
 * @typedef {object} PickerOptions
 * @property {number} [maxVisible]
 * @property {number | string} [width]
 * @property {number | string} [maxHeight]
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {boolean} [fullScreen]
 */

/**
 * @param {string} text
 * @param {number} width
 */
function fit(text, width) {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
}

function border(width) {
	return theme.fg("border", "─".repeat(Math.max(1, width)))
}

function titleBorder(title, width) {
	if (!title) return border(width)
	const label = ` ${title} `
	const rightWidth = Math.max(1, width - 1 - visibleWidth(label))
	return fit(theme.fg("border", "─") + theme.bold(label) + theme.fg("border", "─".repeat(rightWidth)), width)
}

class PickerModal {
	/**
	 * @param {SelectItem[]} items
	 * @param {Required<Pick<PickerOptions, "maxVisible" | "title" | "subtitle" | "fullScreen">> & { getHeight: () => number }} options
	 */
	constructor(items, options) {
		this.title = options.title
		this.subtitle = options.subtitle
		this.fullScreen = options.fullScreen
		this.getHeight = options.getHeight
		this.list = new SelectList(items, options.maxVisible, /** @type {any} */ (editorTheme.selectList), {
			minPrimaryColumnWidth: 14,
			maxPrimaryColumnWidth: 24,
		})
		this.onSelect = undefined
		this.onCancel = undefined
		this.list.onSelect = (item) => this.onSelect?.(item)
		this.list.onCancel = () => this.onCancel?.()
	}

	invalidate() {
		this.list.invalidate()
	}

	/** @param {string} data */
	handleInput(data) {
		this.list.handleInput(data)
	}

	/** @param {number} width */
	render(width) {
		const modalWidth = Math.max(24, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const lines = [
			titleBorder(this.title, modalWidth),
			fit(theme.dim(` ${this.subtitle}`), modalWidth),
			fit(border(modalWidth), modalWidth),
		]
		for (const line of this.list.render(innerWidth)) lines.push(fit(`  ${line}`, modalWidth))
		lines.push(fit(border(modalWidth), modalWidth))
		lines.push(fit(theme.dim(" ↑/↓ move · Enter select · Esc cancel"), modalWidth))
		if (this.fullScreen) while (lines.length < this.getHeight()) lines.push(fit("", modalWidth))
		return lines
	}
}

/**
 * @param {TUI} tui
 * @param {SelectItem[]} items
 * @param {PickerOptions} [options]
 * @returns {Promise<string | null>}
 */
export async function pickFromOverlay(tui, items, options = {}) {
	const fullScreen = options.fullScreen ?? true
	const modal = new PickerModal(items, {
		maxVisible: options.maxVisible ?? Math.min(10, Math.max(1, items.length)),
		title: options.title ?? "Select",
		subtitle: options.subtitle ?? "Choose an item",
		fullScreen,
		getHeight: () => tui.terminal?.rows ?? 24,
	})

	return new Promise((resolve) => {
		const handle = tui.showOverlay(modal, {
			width: options.width ?? (fullScreen ? "100%" : "70%"),
			maxHeight: options.maxHeight ?? (fullScreen ? "100%" : "70%"),
			anchor: fullScreen ? "top-left" : "center",
			backdrop: true,
		})
		/** @param {string | null} value */
		const finish = (value) => {
			handle.hide()
			resolve(value)
		}
		modal.onSelect = (item) => finish(item.value)
		modal.onCancel = () => finish(null)
	})
}
