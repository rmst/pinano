// Promise-wrapped Input overlay for one-shot text prompts (API key entry,
// session rename, etc).

import { Input } from "../../tui/index.js"

/** @typedef {import("../../tui/index.js").TUI} TUI */

/**
 * @param {TUI} tui
 * @param {string} _label
 * @returns {Promise<string | null>}
 */
export async function promptForInput(tui, _label) {
	const input = new Input()
	return new Promise((resolve) => {
		const handle = tui.showOverlay(input, { width: "60%", anchor: "center" })
		/** @param {string | null} v */
		const finish = (v) => {
			handle.hide()
			resolve(v)
		}
		input.onSubmit = (v) => finish(v)
		input.onEscape = () => finish(null)
	})
}
