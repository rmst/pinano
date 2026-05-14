import { applyBackgroundToLine, visibleWidth } from "../utils.js";

/** @typedef {import("../tui.js").Component} Component */

/**
 * @typedef {object} RenderCache
 * @property {string[]} childLines
 * @property {number} width
 * @property {string | undefined} bgSample
 * @property {string[]} lines
 */

/**
 * Box component - a container that applies padding and background to all children
 *
 * @implements {Component}
 */
export class Box {
	/** @type {Component[]} */
	children = [];
	/** @type {number} */
	paddingX;
	/** @type {number} */
	paddingY;
	/** @type {((text: string) => string) | undefined} */
	bgFn;

	// Cache for rendered output
	/** @type {RenderCache | undefined} */
	cache;

	/**
	 * @param {number} [paddingX]
	 * @param {number} [paddingY]
	 * @param {(text: string) => string} [bgFn]
	 */
	constructor(paddingX = 1, paddingY = 1, bgFn) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	/** @param {Component} component */
	addChild(component) {
		this.children.push(component);
		this.invalidateCache();
	}

	/** @param {Component} component */
	removeChild(component) {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear() {
		this.children = [];
		this.invalidateCache();
	}

	/** @param {(text: string) => string} [bgFn] */
	setBgFn(bgFn) {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	invalidateCache() {
		this.cache = undefined;
	}

	/**
	 * @param {number} width
	 * @param {string[]} childLines
	 * @param {string | undefined} bgSample
	 * @returns {boolean}
	 */
	matchCache(width, childLines, bgSample) {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate() {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		/** @type {string[]} */
		const childLines = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
			return /** @type {RenderCache} */ (this.cache).lines;
		}

		// Apply background and padding
		/** @type {string[]} */
		const result = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	/**
	 * @param {string} line
	 * @param {number} width
	 * @returns {string}
	 */
	applyBg(line, width) {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
