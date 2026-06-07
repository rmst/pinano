// Full-width model selector shown via the chat `showSelector` swap.
// Mirrors pi's model selector shape: search input, provider badges, current
// marker, and model metadata.

import {
	Container,
	Input,
	Spacer,
	Text,
	fuzzyFilter,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "../../tui/index.js"
import { theme } from "../theme.js"
import { modelEntryMatches, modelRef, modelRefMatches } from "../models.js"

/** @typedef {import("../../tui/index.js").Component} Component */
/** @typedef {import("../../tui/index.js").Focusable} Focusable */
/** @typedef {import("../models.js").ModelEntry} ModelEntry */

/**
 * @typedef {object} ModelRow
 * @property {string} value
 * @property {ModelEntry} entry
 * @property {boolean} [current]
 */

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
 * @param {ModelEntry} entry
 * @returns {string}
 */
function providerLabel(entry) {
	if (entry.provider === "openai-codex") return "ChatGPT"
	if (entry.provider === "openai") return "OpenAI API"
	if (entry.provider === "llamacpp") return "llama.cpp"
	return entry.provider
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
	if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`
	return String(n)
}

/**
 * @param {ModelEntry} entry
 * @returns {string}
 */
function costText(entry) {
	if (entry.authProvider === "openai-codex") return "subscription"
	const input = entry.cost.input
	const output = entry.cost.output
	if (!input && !output) return "free/local"
	return `$${input}/$${output}`
}

/**
 * @implements {Component}
 * @implements {Focusable}
 */
class ModelList {
	/** @type {ModelRow[]} */
	rows
	/** @type {ModelRow[]} */
	filteredRows
	selectedIndex = 0
	/** @type {Input} */
	searchInput
	focused = false

	/** @type {((row: ModelRow) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/**
	 * @param {ModelRow[]} rows
	 * @param {{
	 *   initialSelectedValue?: string,
	 *   searchInput: Input,
	 * }} opts
	 */
	constructor(rows, opts) {
		this.rows = rows
		this.searchInput = opts.searchInput
		this.filteredRows = this.rows
		const initial = opts.initialSelectedValue
			? this.filteredRows.findIndex((r) => r.value === opts.initialSelectedValue)
			: this.filteredRows.findIndex((r) => r.current)
		this.selectedIndex = initial >= 0 ? initial : 0
	}

	invalidate() {}

	/** @param {string} query */
	filter(query) {
		this.filteredRows = query
			? fuzzyFilter(
					this.rows,
					query,
					({ entry, value }) => `${value} ${entry.id} ${entry.displayName} ${entry.provider} ${providerLabel(entry)}`,
				)
			: this.rows
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredRows.length - 1))
	}

	/**
	 * @param {ModelRow} row
	 * @param {boolean} selected
	 * @param {number} width
	 * @returns {string[]}
	 */
	renderRow(row, selected, width) {
		const entry = row.entry
		const cursor = selected ? theme.fg("accent", "› ") : "  "
		const provider = theme.fg("muted", `[${providerLabel(entry)}]`)
		const check = row.current ? theme.fg("success", " ✓") : ""
		const title = selected ? theme.fg("accent", entry.id) : entry.id
		const summaryParts = [
			entry.displayName,
			`${formatTokens(entry.contextWindow)} ctx`,
			`${formatTokens(entry.maxTokens)} out`,
			costText(entry),
		]
		const prefix = `${cursor}${title} ${provider}${check}`
		const summary = theme.fg("dim", `  ${summaryParts.join(" · ")}`)
		const remaining = Math.max(1, width - visibleWidth(prefix) - 1)
		return [prefix + truncateToWidth(summary, remaining, "…")]
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		if (this.filteredRows.length === 0) return [theme.fg("muted", "  No matching models")]

		const maxVisible = 10
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredRows.length - maxVisible),
		)
		const endIndex = Math.min(startIndex + maxVisible, this.filteredRows.length)
		/** @type {string[]} */
		const lines = []
		for (let i = startIndex; i < endIndex; i++) {
			const row = this.filteredRows[i]
			if (!row) continue
			lines.push(...this.renderRow(row, i === this.selectedIndex, width))
		}
		if (startIndex > 0 || endIndex < this.filteredRows.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredRows.length})`))
		}
		return lines
	}

	/** @param {string | Buffer} keyData */
	handleInput(keyData) {
		const data = typeof keyData === "string" ? keyData : keyData.toString("binary")
		const kb = getKeybindings()
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredRows.length === 0) return
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredRows.length - 1 : this.selectedIndex - 1
			return
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredRows.length === 0) return
			this.selectedIndex = this.selectedIndex === this.filteredRows.length - 1 ? 0 : this.selectedIndex + 1
			return
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const row = this.filteredRows[this.selectedIndex]
			if (row) this.onSelect?.(row)
			return
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.()
			return
		}
		this.searchInput.handleInput(data)
		this.filter(this.searchInput.getValue())
	}
}

/** @implements {Focusable} */
export class ModelSelectorComponent extends Container {
	/** @type {Input} */
	searchInput
	/** @type {ModelList} */
	list
	_focused = false

	/** @type {((row: ModelRow) => void) | undefined} */
	onSelect
	/** @type {(() => void) | undefined} */
	onCancel

	/** @returns {boolean} */
	get focused() {
		return this._focused
	}
	/** @param {boolean} value */
	set focused(value) {
		this._focused = value
		this.searchInput.focused = value
	}

	/**
	 * @param {ModelRow[]} rows
	 * @param {{
	 *   initialSelectedValue?: string,
	 *   title?: string,
	 *   subtitle?: string,
	 *   initialSearchInput?: string,
	 * }} [opts]
	 */
	constructor(rows, opts = {}) {
		super()
		this.addChild(new Spacer(1))
		this.addChild(new Text(theme.bold(opts.title ?? "Select model"), 1, 0))
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					opts.subtitle ?? "Type to search. OAuth-backed models are listed first.",
				),
				1,
				0,
			),
		)

		this.searchInput = new Input()
		if (opts.initialSearchInput) this.searchInput.setValue(opts.initialSearchInput)
		this.searchInput.onSubmit = () => {
			this.list.handleInput("\r")
		}
		this.searchInput.onEscape = () => this.onCancel?.()

		this.list = new ModelList(rows, {
			initialSelectedValue: opts.initialSelectedValue,
			searchInput: this.searchInput,
		})
		this.list.onSelect = (row) => this.onSelect?.(row)
		this.list.onCancel = () => this.onCancel?.()

		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())
		this.addChild(new Spacer(1))
		this.addChild(this.searchInput)
		this.addChild(new Spacer(1))
		this.addChild(this.list)
		this.addChild(new Spacer(1))
		this.addChild(new DynamicBorder())

		if (rows.length === 0) {
			setTimeout(() => this.onCancel?.(), 0)
		}
	}

	/** @returns {Focusable} */
	getFocus() {
		return this
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
 * @param {ModelEntry[]} models
 * @param {{ currentId?: string, currentProvider?: string }} [opts]
 * @returns {ModelRow[]}
 */
export function rowsForModels(models, opts = {}) {
	return models.map((entry) => {
		const value = modelRef(entry)
		return {
			value,
			entry,
			current: opts.currentId ? (opts.currentProvider ? modelEntryMatches(entry, opts.currentId, /** @type {any} */ (opts.currentProvider)) : modelRefMatches(entry, opts.currentId)) : false,
		}
	})
}

/**
 * @param {ShowSelectorCtx} ctx
 * @param {ModelRow[]} rows
 * @param {{
 *   initialSelectedValue?: string,
 *   title?: string,
 *   subtitle?: string,
 * }} [opts]
 * @returns {Promise<string | null>}
 */
export async function pickModel(ctx, rows, opts = {}) {
	if (rows.length === 0) return null
	return new Promise((resolve) => {
		ctx.showSelector((done) => {
			const selector = new ModelSelectorComponent(rows, opts)
			selector.onSelect = (row) => {
				done()
				resolve(row.value)
			}
			selector.onCancel = () => {
				done()
				resolve(null)
			}
			return { component: selector, focus: selector.getFocus() }
		})
	})
}
