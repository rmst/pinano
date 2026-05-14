// Promise-wrapped SelectList overlay.
//
// Resolves with the chosen item.value, or null on Esc/cancel.

import { SelectList } from "../../tui/index.js"
import { editorTheme } from "../theme.js"

/** @typedef {import("../../tui/index.js").SelectItem} SelectItem */
/** @typedef {import("../../tui/index.js").TUI} TUI */

/**
 * @typedef {object} PickerOptions
 * @property {number} [maxVisible]
 * @property {number | string} [width]
 * @property {number | string} [maxHeight]
 */

/**
 * @param {TUI} tui
 * @param {SelectItem[]} items
 * @param {PickerOptions} [options]
 * @returns {Promise<string | null>}
 */
export async function pickFromOverlay(tui, items, options = {}) {
	const list = new SelectList(items, options.maxVisible ?? 10, /** @type {any} */ (editorTheme.selectList))

	return new Promise((resolve) => {
		const handle = tui.showOverlay(list, {
			width: options.width ?? "60%",
			maxHeight: options.maxHeight ?? "70%",
			anchor: "center",
		})
		/** @param {string | null} value */
		const finish = (value) => {
			handle.hide()
			resolve(value)
		}
		list.onSelect = (item) => finish(item.value)
		list.onCancel = () => finish(null)
	})
}
