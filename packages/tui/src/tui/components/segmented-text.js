import { RetainedComponent } from "../tui.js";
import { getSegmenter, sanitizeRenderableText, visibleWidth } from "../utils.js";

const segmenter = getSegmenter();

/**
 * @typedef {object} TextSegment
 * @property {string} text Plain visible text. Terminal controls are stripped; use `style` for SGR styling.
 * @property {(text: string) => string} [style]
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [label]
 * @property {any} [metadata]
 * @property {import("../selection-source.js").TextSelectionSource} [sourceProvider]
 * @property {string} [sourceId]
 * @property {number} [sourceStart]
 * @property {number} [sourceEnd]
 * @property {boolean} [selectionIgnore]
 * @property {(event: any) => any} [onClick]
 * @property {(event: any) => any} [onContextMenu]
 * @property {(event: any) => any} [onMouse]
 */

/**
 * @typedef {object} SegmentUnit
 * @property {string} text
 * @property {number} width
 * @property {boolean} whitespace
 * @property {TextSegment} segment
 * @property {import("../selection-source.js").TextSelectionSource} [sourceProvider]
 * @property {string} [sourceId]
 * @property {number} [sourceStart]
 * @property {number} [sourceEnd]
 * @property {boolean} [selectionIgnore]
 */

/**
 * Styled inline text with optional span metadata. This is intentionally smaller
 * than a DOM text node model: segment text is plain, styling is applied by a
 * function, and spans are terminal-cell ranges in the final rendered rows.
 */
export class SegmentedText extends RetainedComponent {
	/** @type {TextSegment[]} */
	segments;
	paddingX;
	paddingY;
	/** @type {{ width: number, segments: TextSegment[], frame: { lines: string[], spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[] } } | undefined} */
	cache;

	/**
	 * @param {TextSegment[]} [segments]
	 * @param {{ paddingX?: number, paddingY?: number }} [options]
	 */
	constructor(segments = [], options = {}) {
		super();
		this.segments = segments;
		this.paddingX = options.paddingX ?? 0;
		this.paddingY = options.paddingY ?? 0;
	}

	/** @returns {string} */
	get text() {
		return this.segments.map((segment) => segment.text ?? "").join("");
	}

	/** @param {TextSegment[]} segments */
	setSegments(segments) {
		this.segments = segments;
		this.cache = undefined;
		this.markDirty();
	}

	invalidate() {
		this.cache = undefined;
		this.markDirty();
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[] }}
	 */
	renderFrame(width) {
		if (this.cache && this.cache.width === width && this.cache.segments === this.segments) return this.cache.frame;
		const frame = renderSegmentedText(this.segments, width, {
			paddingX: this.paddingX,
			paddingY: this.paddingY,
			component: this,
		});
		this.cache = { width, segments: this.segments, frame };
		return frame;
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines;
	}
}

/**
 * @param {TextSegment[]} segments
 * @param {number} width
 * @param {{ paddingX?: number, paddingY?: number, component?: any, firstLinePrefix?: TextSegment[], continuationLinePrefix?: TextSegment[] }} options
 * @returns {{ lines: string[], spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[] }}
 */
export function renderSegmentedText(segments, width, options = {}) {
	const printableWidth = Math.max(0, Math.floor(width));
	const text = segments.map((segment) => segment.text ?? "").join("");
	const firstLinePrefix = options.firstLinePrefix ?? [];
	const continuationLinePrefix = options.continuationLinePrefix ?? [];
	const prefixText = firstLinePrefix.map((segment) => segment.text ?? "").join("");
	if ((!text || text.trim() === "") && prefixText.length === 0) return { lines: [], spans: [], sourceSpans: [] };

	const paddingX = Math.max(0, Math.floor(options.paddingX ?? 0));
	const paddingY = Math.max(0, Math.floor(options.paddingY ?? 0));
	const contentWidth = Math.max(1, printableWidth - paddingX * 2);
	const wrapped = wrapSegmentUnits(tokenizeSegments(segments), contentWidth, {
		firstLinePrefix: tokenizePrefix(firstLinePrefix),
		continuationLinePrefix: tokenizePrefix(continuationLinePrefix),
	});
	const emptyLine = " ".repeat(printableWidth);
	/** @type {string[]} */
	const lines = [];
	/** @type {import("../render-frame.js").RenderSpan[]} */
	const spans = [];
	/** @type {import("../render-frame.js").RenderSourceSpan[]} */
	const sourceSpans = [];

	for (let i = 0; i < paddingY; i++) lines.push(emptyLine);
	for (let i = 0; i < wrapped.length; i++) {
		const rendered = renderUnitLine(wrapped[i], {
			lineIndex: lines.length,
			width: printableWidth,
			paddingX,
			component: options.component,
		});
		lines.push(rendered.line);
		spans.push(...rendered.spans);
		sourceSpans.push(...rendered.sourceSpans);
	}
	for (let i = 0; i < paddingY; i++) lines.push(emptyLine);

	return { lines, spans, sourceSpans };
}

/**
 * @param {TextSegment[]} segments
 * @returns {Array<{ units: SegmentUnit[], whitespace: boolean, newline?: boolean, width: number }>}
 */
function tokenizeSegments(segments) {
	/** @type {Array<{ units: SegmentUnit[], whitespace: boolean, newline?: boolean, width: number }>} */
	const tokens = [];
	/** @type {{ units: SegmentUnit[], whitespace: boolean, width: number } | undefined} */
	let current;
	const flush = () => {
		if (!current || current.units.length === 0) return;
		tokens.push(current);
		current = undefined;
	};

	for (const segment of segments) {
		const text = sanitizeRenderableText(segment.text ?? "", { preserveLineBreaks: true });
		let sourceOffset = Number.isFinite(segment.sourceStart) ? Math.floor(segment.sourceStart) : undefined;
		for (const { segment: grapheme } of segmenter.segment(text)) {
			if (grapheme === "\n") {
				flush();
				tokens.push({ units: [], whitespace: false, newline: true, width: 0 });
				if (sourceOffset !== undefined) sourceOffset += grapheme.length;
				continue;
			}
			const whitespace = grapheme.trim() === "";
			const sourceStart = sourceOffset;
			const sourceEnd = sourceOffset === undefined ? undefined : sourceOffset + grapheme.length;
			const unit = {
				text: grapheme,
				width: visibleWidth(grapheme),
				whitespace,
				segment,
				sourceProvider: segment.sourceProvider,
				sourceId: segment.sourceId ?? segment.sourceProvider?.id,
				sourceStart,
				sourceEnd,
				selectionIgnore: segment.selectionIgnore === true,
			};
			if (sourceOffset !== undefined) sourceOffset = sourceEnd;
			if (!current || current.whitespace !== whitespace) {
				flush();
				current = { units: [], whitespace, width: 0 };
			}
			current.units.push(unit);
			current.width += unit.width;
		}
	}
	flush();
	return tokens;
}

/**
 * @param {Array<{ units: SegmentUnit[], whitespace: boolean, newline?: boolean, width: number }>} tokens
 * @param {number} width
 * @param {{ firstLinePrefix?: SegmentUnit[], continuationLinePrefix?: SegmentUnit[] }} [options]
 * @returns {SegmentUnit[][]}
 */
function wrapSegmentUnits(tokens, width, options = {}) {
	/** @type {SegmentUnit[][]} */
	const lines = [];
	/** @type {SegmentUnit[]} */
	let current = [];
	let currentWidth = 0;
	const firstPrefix = options.firstLinePrefix ?? [];
	const continuationPrefix = options.continuationLinePrefix ?? [];
	const prefixForNextLine = () => lines.length === 0 ? firstPrefix : continuationPrefix;
	const capacityForNextLine = () => Math.max(1, width - unitsWidth(prefixForNextLine()));
	const pushCurrent = () => {
		current = trimTrailingWhitespace(current);
		lines.push([...prefixForNextLine(), ...current]);
		current = [];
		currentWidth = 0;
	};

	for (const token of tokens) {
		if (token.newline) {
			pushCurrent();
			continue;
		}

		const capacity = capacityForNextLine();
		if (token.width > capacity && !token.whitespace) {
			if (current.length > 0) pushCurrent();
			for (const unit of token.units) {
				if (current.length > 0 && currentWidth + unit.width > capacityForNextLine()) pushCurrent();
				current.push(unit);
				currentWidth += unit.width;
			}
			continue;
		}

		if (currentWidth + token.width > capacity && currentWidth > 0) {
			pushCurrent();
			if (token.whitespace) continue;
		}

		current.push(...token.units);
		currentWidth += token.width;
	}

	if (current.length > 0 || lines.length === 0) pushCurrent();
	return lines;
}

/**
 * @param {TextSegment[]} segments
 * @returns {SegmentUnit[]}
 */
function tokenizePrefix(segments) {
	return tokenizeSegments(segments).flatMap((token) => token.units);
}

/**
 * @param {SegmentUnit[]} units
 * @returns {number}
 */
function unitsWidth(units) {
	return units.reduce((total, unit) => total + unit.width, 0);
}

/**
 * @param {SegmentUnit[]} units
 * @returns {SegmentUnit[]}
 */
function trimTrailingWhitespace(units) {
	let end = units.length;
	while (end > 0 && units[end - 1].whitespace) end--;
	return end === units.length ? units : units.slice(0, end);
}

/**
 * @param {SegmentUnit[]} units
 * @param {{ lineIndex: number, width: number, paddingX: number, component: any }} options
 * @returns {{ line: string, spans: import("../render-frame.js").RenderSpan[], sourceSpans: import("../render-frame.js").RenderSourceSpan[] }}
 */
function renderUnitLine(units, options) {
	let line = " ".repeat(options.paddingX);
	let col = options.paddingX;
	/** @type {import("../render-frame.js").RenderSpan[]} */
	const spans = [];
	/** @type {import("../render-frame.js").RenderSourceSpan[]} */
	const sourceSpans = [];
	for (let i = 0; i < units.length;) {
		const segment = units[i].segment;
		let text = "";
		let width = 0;
		const startCol = col;
		const startIndex = i;
		while (i < units.length && units[i].segment === segment) {
			text += units[i].text;
			width += units[i].width;
			i++;
		}
		line += segment.style ? segment.style(text) : text;
		if (spanHasMetadata(segment) && width > 0) {
			spans.push({
				line: options.lineIndex,
				startCol: col,
				endCol: col + width,
				component: options.component,
				id: segment.id,
				role: segment.role,
				label: segment.label,
				metadata: segment.metadata,
				onClick: segment.onClick,
				onContextMenu: segment.onContextMenu,
				onMouse: segment.onMouse,
			});
		}
		sourceSpans.push(...sourceSpansForUnits(units.slice(startIndex, i), {
			line: options.lineIndex,
			startCol,
			component: options.component,
			role: segment.role,
			metadata: segment.metadata,
		}));
		col += width;
	}
	line += " ".repeat(options.paddingX);
	const paddingNeeded = Math.max(0, options.width - visibleWidth(line));
	return { line: line + " ".repeat(paddingNeeded), spans, sourceSpans };
}

/**
 * @param {SegmentUnit[]} units
 * @param {{ line: number, startCol: number, component: any, role?: string, metadata?: any }} options
 * @returns {import("../render-frame.js").RenderSourceSpan[]}
 */
function sourceSpansForUnits(units, options) {
	/** @type {import("../render-frame.js").RenderSourceSpan[]} */
	const spans = [];
	let col = options.startCol;
	let current = /** @type {import("../render-frame.js").RenderSourceSpan | null} */ (null);
	const flush = () => {
		if (current) spans.push(current);
		current = null;
	};

	for (const unit of units) {
		const nextCol = col + unit.width;
		if (unit.selectionIgnore && unit.width > 0) {
			if (current?.ignore && current.endCol === col) {
				current.endCol = nextCol;
			} else {
				flush();
				current = {
					line: options.line,
					startCol: col,
					endCol: nextCol,
					ignore: true,
					component: options.component,
					role: options.role,
					metadata: options.metadata,
				};
			}
			col = nextCol;
			continue;
		}
		if (!unit.sourceProvider || !unit.sourceId || unit.sourceStart === undefined || unit.sourceEnd === undefined || unit.width <= 0) {
			flush();
			col = nextCol;
			continue;
		}
		if (
			current
			&& current.provider === unit.sourceProvider
			&& current.sourceId === unit.sourceId
			&& current.sourceEnd === unit.sourceStart
			&& current.endCol === col
		) {
			current.endCol = nextCol;
			current.sourceEnd = unit.sourceEnd;
		} else {
			flush();
			current = {
				line: options.line,
				startCol: col,
				endCol: nextCol,
				provider: unit.sourceProvider,
				sourceId: unit.sourceId,
				sourceStart: unit.sourceStart,
				sourceEnd: unit.sourceEnd,
				component: options.component,
				role: options.role,
				metadata: options.metadata,
			};
		}
		col = nextCol;
	}
	flush();
	return spans;
}

/**
 * @param {TextSegment} segment
 * @returns {boolean}
 */
function spanHasMetadata(segment) {
	return segment.id !== undefined
		|| segment.role !== undefined
		|| segment.label !== undefined
		|| segment.metadata !== undefined
		|| typeof segment.onClick === "function"
		|| typeof segment.onContextMenu === "function"
		|| typeof segment.onMouse === "function";
}
