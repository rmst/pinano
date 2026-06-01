import { RetainedComponent } from "../tui.js";

/** @typedef {import("../tui.js").Component} Component */

/**
 * Spacer component that renders empty lines
 * @implements {Component}
 */
export class Spacer extends RetainedComponent {
	/** @type {number} */
	lines;

	/** @param {number} [lines] */
	constructor(lines = 1) {
		super();
		this.lines = lines;
	}

	/** @param {number} lines */
	setLines(lines) {
		this.lines = lines;
		this.markDirty();
	}

	invalidate() {
		this.markDirty();
	}

	/**
	 * @param {number} _width
	 * @returns {string[]}
	 */
	render(_width) {
		/** @type {string[]} */
		const result = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
