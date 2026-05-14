import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

/** @typedef {import("../tui.js").Component} Component */

/**
 * Text component - displays multi-line text with word wrapping
 *
 * @implements {Component}
 */
export class Text {
	/** @type {string} */
	text;
	/** @type {number} */
	paddingX; // Left/right padding
	/** @type {number} */
	paddingY; // Top/bottom padding
	/** @type {((text: string) => string) | undefined} */
	customBgFn;

	// Cache for rendered output
	/** @type {string | undefined} */
	cachedText;
	/** @type {number | undefined} */
	cachedWidth;
	/** @type {string[] | undefined} */
	cachedLines;

	/**
	 * @param {string} [text]
	 * @param {number} [paddingX]
	 * @param {number} [paddingY]
	 * @param {(text: string) => string} [customBgFn]
	 */
	constructor(text = "", paddingX = 1, paddingY = 1, customBgFn) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	/** @param {string} text */
	setText(text) {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	/** @param {(text: string) => string} [customBgFn] */
	setCustomBgFn(customBgFn) {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate() {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			/** @type {string[]} */
			const result = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Calculate content width (subtract left/right margins)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// Add margins and background to each line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		/** @type {string[]} */
		const contentLines = [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		/** @type {string[]} */
		const emptyLines = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}
