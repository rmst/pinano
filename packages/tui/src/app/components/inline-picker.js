// Inline option picker — full-width SelectList wrapped in a titled frame and
// shown in place of the editor via the `showSelector` swap.
//
// Use this for short, prompt-style option lists ("Summarize? [No / Yes / Yes
// with custom prompt]") where a centered modal would feel cramped relative
// to the rest of the UI.

import { Container, SelectList, Spacer, Text } from "../../tui/index.js"
import { selectListTheme, theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").Component} Component */
/** @typedef {import("../../tui/index.js").Focusable} Focusable */
/** @typedef {import("../../tui/index.js").SelectItem} SelectItem */

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

/** @implements {Focusable} */
export class InlinePickerComponent extends Container {
	/** @type {SelectList} */
	list
	/** @type {Text | undefined} */
	selectedDescription
	focused = false

	/** @type {((item: SelectItem) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/**
	 * @param {SelectItem[]} items
	 * @param {{ title?: string, subtitle?: string, maxVisible?: number, descriptionMode?: "inline" | "selected" }} [opts]
	 */
	constructor(items, opts = {}) {
		super()
		if (opts.title) {
			this.addChild(new Spacer(1))
			this.addChild(new Text(theme.bold(opts.title), 1, 0))
			if (opts.subtitle) {
				this.addChild(new Text(theme.fg("muted", opts.subtitle), 1, 0))
			}
			this.addChild(new Spacer(1))
			this.addChild(new DynamicBorder())
			this.addChild(new Spacer(1))
		}

		const itemsByValue = new Map(items.map((item) => [item.value, item]))
		const descriptionsByValue = new Map(items.map((item) => [item.value, item.description ?? ""]))
		const listItems = opts.descriptionMode === "selected"
			? items.map((item) => ({ ...item, description: undefined }))
			: items
		this.list = new SelectList(listItems, opts.maxVisible ?? Math.max(items.length, 5), /** @type {any} */ (selectListTheme))
		this.list.onSelect = (item) => this.onSelect?.(itemsByValue.get(item.value) ?? item)
		this.list.onCancel = () => this.onCancel?.()
		this.addChild(this.list)

		if (opts.descriptionMode === "selected") {
			const selectedDescriptionText = () => {
				const description = descriptionsByValue.get(this.list.getSelectedItem()?.value ?? "") ?? ""
				return description ? theme.fg("muted", description) : ""
			}
			this.selectedDescription = new Text(selectedDescriptionText(), 1, 0)
			this.list.onSelectionChange = () => this.selectedDescription?.setText(selectedDescriptionText())
			this.addChild(new Spacer(1))
			this.addChild(this.selectedDescription)
		}

		if (opts.title) {
			this.addChild(new Spacer(1))
			this.addChild(new DynamicBorder())
		}
	}

	/** @returns {SelectList} */
	getList() {
		return this.list
	}

	/** @param {string | Buffer} data */
	handleInput(data) {
		this.list.handleInput(/** @type {any} */ (data))
	}
}

/**
 * @typedef {object} ShowSelectorCtx
 * @property {(create: (done: () => void) => { component: Component, focus: Component }) => void} showSelector
 */

/**
 * Promise wrapper. Resolves with the picked item's `value`, or `null` on
 * Esc / cancel.
 *
 * @param {ShowSelectorCtx} ctx
 * @param {SelectItem[]} items
 * @param {{ title?: string, subtitle?: string, maxVisible?: number, descriptionMode?: "inline" | "selected" }} [opts]
 * @returns {Promise<string | null>}
 */
export async function pickInline(ctx, items, opts = {}) {
	return new Promise((resolve) => {
		ctx.showSelector((done) => {
			const picker = new InlinePickerComponent(items, opts)
			picker.onSelect = (item) => {
				done()
				resolve(item.value)
			}
			picker.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: picker, focus: picker.getList() }
		})
	})
}
