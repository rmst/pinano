import { RetainedContainer } from "../tui.js";
import { offsetRegions, offsetSourceSpans, offsetSpans } from "../render-frame.js";
import { applyBackgroundToLine, visibleWidth } from "../utils.js";

/** @typedef {import("../tui.js").Component} Component */

/**
 * @typedef {object} RenderCache
 * @property {string[]} childLines
 * @property {import("../render-frame.js").RenderSpan[]} childSpans
 * @property {import("../render-frame.js").RenderSourceSpan[]} childSourceSpans
 * @property {import("../render-frame.js").RenderRegion[]} childRegions
 * @property {number} width
 * @property {string | undefined} bgSample
 * @property {string[]} lines
 * @property {import("../render-frame.js").RenderSpan[]} spans
 * @property {import("../render-frame.js").RenderSourceSpan[]} sourceSpans
 * @property {import("../render-frame.js").RenderRegion[]} regions
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
	 * @param {import("../render-frame.js").RenderSpan[]} childSpans
	 * @param {import("../render-frame.js").RenderSourceSpan[]} childSourceSpans
	 * @param {import("../render-frame.js").RenderRegion[]} childRegions
	 * @param {string | undefined} bgSample
	 * @returns {boolean}
	 */
	matchCache(width, childLines, childSpans, childSourceSpans, childRegions, bgSample) {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i]) &&
			cache.childSpans.length === childSpans.length &&
			cache.childSpans.every((span, i) => spansEqual(span, childSpans[i])) &&
			cache.childSourceSpans.length === childSourceSpans.length &&
			cache.childSourceSpans.every((span, i) => sourceSpansEqual(span, childSourceSpans[i])) &&
			cache.childRegions.length === childRegions.length &&
			cache.childRegions.every((region, i) => regionsEqual(region, childRegions[i]))
		);
	}

	invalidate() {
		this.invalidateCache();
		super.invalidate();
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[], regions: import("../render-frame.js").RenderRegion[], dirtyStart: number }}
	 */
	renderIncremental(width) {
		if (this.children.length === 0) {
			this.cache = undefined;
			this.clearDirty();
			return { lines: [], spans: [], sourceSpans: [], regions: [], dirtyStart: 0 };
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const childResult = this.renderChildrenIncremental(contentWidth);

		/** @type {string[]} */
		const childLines = [];
		for (const line of childResult.lines) {
			childLines.push(leftPad + line);
		}
		const childSpans = offsetSpans(childResult.spans, this.paddingY, this.paddingX);
		const childSourceSpans = offsetSourceSpans(childResult.sourceSpans, this.paddingY, this.paddingX);
		const childRegions = offsetRegions(childResult.regions, this.paddingY, this.paddingX);

		if (childLines.length === 0) {
			this.cache = undefined;
			this.clearDirty();
			return { lines: [], spans: [], sourceSpans: [], regions: [], dirtyStart: 0 };
		}

		const previousCache = this.cache;
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		if (this.matchCache(width, childLines, childSpans, childSourceSpans, childRegions, bgSample)) {
			this.clearDirty();
			const cache = /** @type {RenderCache} */ (this.cache);
			return { lines: cache.lines, spans: cache.spans, sourceSpans: cache.sourceSpans, regions: cache.regions, dirtyStart: Infinity };
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

		this.cache = { childLines, childSpans, childSourceSpans, childRegions, width, bgSample, lines: result, spans: childSpans, sourceSpans: childSourceSpans, regions: childRegions };
		this.clearDirty();

		const fullDirty = !previousCache || previousCache.width !== width || previousCache.bgSample !== bgSample;
		const dirtyStart = fullDirty || childResult.dirtyStart === Infinity
			? 0
			: this.paddingY + childResult.dirtyStart;
		return { lines: result, spans: childSpans, sourceSpans: childSourceSpans, regions: childRegions, dirtyStart };
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

/**
 * @param {import("../render-frame.js").RenderSpan} a
 * @param {import("../render-frame.js").RenderSpan} b
 * @returns {boolean}
 */
function spansEqual(a, b) {
	return a.line === b.line
		&& a.startCol === b.startCol
		&& a.endCol === b.endCol
		&& a.component === b.component
		&& a.id === b.id
		&& a.role === b.role
		&& a.label === b.label
		&& a.metadata === b.metadata
		&& a.onClick === b.onClick
		&& a.onContextMenu === b.onContextMenu
		&& a.onMouse === b.onMouse;
}

/**
 * @param {import("../render-frame.js").RenderSourceSpan} a
 * @param {import("../render-frame.js").RenderSourceSpan} b
 * @returns {boolean}
 */
function sourceSpansEqual(a, b) {
	return a.line === b.line
		&& a.startCol === b.startCol
		&& a.endCol === b.endCol
		&& a.provider === b.provider
		&& a.sourceId === b.sourceId
		&& a.sourceStart === b.sourceStart
		&& a.sourceEnd === b.sourceEnd
		&& a.ignore === b.ignore
		&& a.component === b.component
		&& a.role === b.role
		&& a.metadata === b.metadata;
}

/**
 * @param {import("../render-frame.js").RenderRegion} a
 * @param {import("../render-frame.js").RenderRegion} b
 * @returns {boolean}
 */
function regionsEqual(a, b) {
	return a.line === b.line
		&& a.startCol === b.startCol
		&& a.endCol === b.endCol
		&& a.component === b.component
		&& a.componentLine === b.componentLine
		&& a.componentStartCol === b.componentStartCol;
}
