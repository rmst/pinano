/** @typedef {import("../tui.js").Component} Component */

/**
 * Spacer component that renders empty lines
 * @implements {Component}
 */
export class Spacer {
	/** @type {number} */
	lines;

	/** @param {number} [lines] */
	constructor(lines = 1) {
		this.lines = lines;
	}

	/** @param {number} lines */
	setLines(lines) {
		this.lines = lines;
	}

	invalidate() {
		// No cached state to invalidate currently
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
