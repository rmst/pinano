import { RetainedContainer, Spacer } from "../../tui/index.js"

/** @typedef {"user" | "assistant" | "tool" | "custom" | "separator"} TranscriptItemKind */

/**
 * Transcript layout owns spacing between visible chat items. Message and tool
 * components own only their internal padding, while this container keeps tool
 * groups compact and skips invisible streaming placeholders.
 */
export class TranscriptContainer extends RetainedContainer {
	/** @type {WeakMap<import("../../tui/index.js").Component, TranscriptItemKind>} */
	itemKinds = new WeakMap()

	/** @param {import("../../tui/index.js").Component} component */
	addChild(component) {
		this.addItem(component, "custom")
	}

	/**
	 * @param {import("../../tui/index.js").Component} component
	 * @param {TranscriptItemKind} kind
	 */
	addItem(component, kind) {
		this.itemKinds.set(component, kind)
		super.addChild(component)
	}

	addSeparator() {
		const last = this.children[this.children.length - 1]
		if (last && this.kindFor(last) === "separator") return
		const spacer = new Spacer(1)
		this.itemKinds.set(spacer, "separator")
		super.addChild(spacer)
	}

	/** @param {import("../../tui/index.js").Component} component */
	removeChild(component) {
		this.itemKinds.delete(component)
		super.removeChild(component)
	}

	clear() {
		this.itemKinds = new WeakMap()
		super.clear()
	}

	/**
	 * @param {import("../../tui/index.js").Component} component
	 * @returns {TranscriptItemKind}
	 */
	kindFor(component) {
		return this.itemKinds.get(component) ?? "custom"
	}

	/**
	 * @param {TranscriptItemKind | undefined} previousKind
	 * @param {TranscriptItemKind} kind
	 */
	shouldSeparate(previousKind, kind) {
		if (!previousKind) return false
		if (kind === "separator") return false
		if (previousKind === "tool" && kind === "tool") return false
		if (previousKind === "custom" && kind === "custom") return false
		return true
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], dirtyStart: number }}
	 */
	renderIncremental(width) {
		const result = this.renderChildrenIncremental(width)
		/** @type {string[]} */
		const lines = []
		/** @type {TranscriptItemKind | undefined} */
		let previousKind
		let dirtyStart = Infinity

		for (const record of result.childRecords) {
			const kind = this.kindFor(record.component)
			const childLines = result.lines.slice(record.start, record.start + record.length)
			const recordDirty = result.dirtyStart !== Infinity
				&& dirtyStart === Infinity
				&& record.start + Math.max(1, record.length) > result.dirtyStart

			if (kind === "separator") {
				if (recordDirty) dirtyStart = lines.length
				for (const line of childLines) lines.push(line)
				previousKind = undefined
				continue
			}

			if (childLines.length === 0) {
				if (recordDirty) dirtyStart = lines.length
				continue
			}

			const itemStart = lines.length
			if (this.shouldSeparate(previousKind, kind) && lines[lines.length - 1] !== "") lines.push("")
			if (recordDirty) dirtyStart = itemStart
			for (const line of childLines) lines.push(line)
			previousKind = kind
		}

		if (result.dirtyStart !== Infinity && dirtyStart === Infinity) dirtyStart = lines.length
		this.clearDirty()
		return { lines, dirtyStart }
	}

	/** @param {number} width */
	render(width) {
		return this.renderIncremental(width).lines
	}
}
