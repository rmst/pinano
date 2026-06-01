import { RetainedContainer } from "../tui.js";
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
export class Box extends RetainedContainer {
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
		super();
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	/** @param {(text: string) => string} [bgFn] */
	setBgFn(bgFn) {
		this.bgFn = bgFn;
		this.markDirty();
	}

	invalidateCache() {
		this.cache = undefined;
		this.markDirty();
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
		super.invalidate();
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], dirtyStart: number }}
	 */
	renderIncremental(width) {
		if (this.children.length === 0) {
			this.cache = undefined;
			this.clearDirty();
			return { lines: [], dirtyStart: 0 };
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const childResult = this.renderChildrenIncremental(contentWidth);

		/** @type {string[]} */
		const childLines = [];
		for (const line of childResult.lines) {
			childLines.push(leftPad + line);
		}

		if (childLines.length === 0) {
			this.cache = undefined;
			this.clearDirty();
			return { lines: [], dirtyStart: 0 };
		}

		const previousCache = this.cache;
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		if (this.matchCache(width, childLines, bgSample)) {
			this.clearDirty();
			return { lines: /** @type {RenderCache} */ (this.cache).lines, dirtyStart: Infinity };
		}

		/** @type {string[]} */
		const result = [];

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		this.cache = { childLines, width, bgSample, lines: result };
		this.clearDirty();

		const fullDirty = !previousCache || previousCache.width !== width || previousCache.bgSample !== bgSample;
		const dirtyStart = fullDirty || childResult.dirtyStart === Infinity
			? 0
			: this.paddingY + childResult.dirtyStart;
		return { lines: result, dirtyStart };
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		return this.renderIncremental(width).lines;
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
