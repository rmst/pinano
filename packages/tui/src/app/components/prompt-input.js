// Promise-wrapped Input overlay for one-shot text prompts (API key entry,
// session rename, etc).

import { Input, RetainedComponent, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui/index.js"
import { theme } from "../theme.js"

/** @typedef {import("../../tui/index.js").TUI} TUI */

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

class PromptInputModal extends RetainedComponent {
	constructor(label, options = {}) {
		super()
		this.label = label
		this.options = options
		this.fullScreen = options.fullScreen ?? true
		this.getHeight = options.getHeight ?? (() => 24)
		this.focused = false
		this.input = new Input()
		this.input.secret = options.secret === true
		this.onSubmit = undefined
		this.onEscape = undefined
		this.input.onSubmit = (value) => this.onSubmit?.(value)
		this.input.onEscape = () => this.onEscape?.()
	}

	/** @param {string} data */
	handleInput(data) {
		this.input.handleInput(data)
		this.markDirty()
	}

	/** @param {number} width */
	render(width) {
		const modalWidth = Math.max(44, width)
		const innerWidth = Math.max(1, modalWidth - 4)
		const title = this.options.title ?? this.label
		const subtitle = this.options.subtitle ?? ""
		this.input.focused = this.focused

		const lines = [titleBorder(title, modalWidth)]
		if (subtitle) lines.push(...wrapTextWithAnsi(theme.dim(` ${subtitle}`), modalWidth).map((line) => fit(line, modalWidth)))
		lines.push(fit(border(modalWidth), modalWidth))
		lines.push(...this.input.render(innerWidth).map((line) => fit(`  ${line}`, modalWidth)))
		lines.push(fit(border(modalWidth), modalWidth))
		lines.push(fit(theme.dim(" Enter save · Esc cancel"), modalWidth))
		if (this.fullScreen) while (lines.length < this.getHeight()) lines.push(fit("", modalWidth))
		return lines
	}
}

/**
 * @param {TUI} tui
 * @param {string} label
 * @param {{ secret?: boolean, title?: string, subtitle?: string, fullScreen?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<string | null>}
 */
export async function promptForInput(tui, label, options = {}) {
	const fullScreen = options.fullScreen ?? true
	const modal = new PromptInputModal(label, { ...options, fullScreen, getHeight: () => tui.terminal?.rows ?? 24 })
	return new Promise((resolve) => {
		const handle = tui.showOverlay(modal, {
			width: fullScreen ? "100%" : "86%",
			maxHeight: fullScreen ? "100%" : "60%",
			anchor: fullScreen ? "top-left" : "center",
			backdrop: true,
		})
		let done = false
		/** @param {string | null} v */
		const finish = (v) => {
			if (done) return
			done = true
			options.signal?.removeEventListener("abort", abort)
			handle.hide()
			resolve(v)
		}
		const abort = () => finish(null)
		modal.onSubmit = (v) => finish(v)
		modal.onEscape = () => finish(null)
		if (options.signal?.aborted) finish(null)
		else options.signal?.addEventListener("abort", abort, { once: true })
	})
}
