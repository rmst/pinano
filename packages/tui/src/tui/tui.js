/**
 * Minimal TUI implementation with differential rendering
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { copyTextToHostClipboard } from "./clipboard-text.js";
import { isKeyRelease, matchesKey } from "./keys.js";
import { parseMouseEvent } from "./mouse.js";
import { clipRegionColumns, clipSourceSpanColumns, clipSpanColumns, normalizeRenderFrame, removeRegionColumns, removeSourceSpanColumns, removeSpanColumns } from "./render-frame.js";
import { Container, componentParent, isFocusable, localPointForRegion, markComponentDirty, renderComponentFrame, setComponentParent } from "./retained.js";
import { ScreenMap } from "./screen-map.js";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { TERMINAL_FOCUS_REPORTING_DISABLE_SEQUENCE, TERMINAL_FOCUS_REPORTING_ENABLE_SEQUENCE } from "./terminal-presence.js";
import { extractSegments, normalizeTerminalOutput, sanitizeRenderableText, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

export { Container, isFocusable, markComponentDirty, RetainedComponent, RetainedContainer, setComponentParent } from "./retained.js";

/** @typedef {import("./terminal.js").Terminal} Terminal */
/** @typedef {import("./mouse.js").MouseEvent} MouseEvent */
/** @typedef {(text: string) => Promise<boolean> | boolean | void} HostClipboardCopy */
/** @typedef {(err: unknown) => void} HostClipboardCopyErrorHandler */
/** @typedef {"line_break" | "width_overflow"} RenderContractViolationReason */
/**
 * @typedef {object} RenderContractViolationDiagnostic
 * @property {"render_contract_violation"} type
 * @property {RenderContractViolationReason} reason
 * @property {number} lineIndex
 * @property {number} terminalWidth
 * @property {number} lineWidth
 * @property {string} preview
 * @property {Component | undefined} component
 * @property {string} componentName
 * @property {number | undefined} componentLine
 */
/**
 * @typedef {object} FullRedrawDiagnostic
 * @property {"full_redraw"} type
 * @property {string} reason
 * @property {number} previousLineCount
 * @property {number} nextLineCount
 * @property {number} terminalWidth
 * @property {number} terminalHeight
 */
/** @typedef {RenderContractViolationDiagnostic | FullRedrawDiagnostic} TuiDiagnostic */
/** @typedef {(diagnostic: TuiDiagnostic) => void} TuiDiagnosticHandler */
/**
 * @typedef {object} TuiOptions
 * @property {boolean} [showHardwareCursor]
 * @property {boolean} [clearOnShrink]
 * @property {HostClipboardCopy} [hostClipboardCopy]
 * @property {HostClipboardCopyErrorHandler} [onHostClipboardCopyError]
 * @property {TuiDiagnosticHandler} [onDiagnostic]
 * @property {boolean} [debugRedraw]
 */

/**
 * Component interface - all components must implement this
 * @typedef {object} Component
 * @property {(width: number) => string[]} render Render the component to lines for the given viewport width
 * @property {(width: number) => import("./render-frame.js").RenderFrame} [renderFrame] Optional structured render output with span metadata.
 * @property {(data: string) => void} [handleInput] Optional handler for keyboard input when component has focus
 * @property {(event: TuiMouseEvent) => any} [handleMouseCapture] Optional capture-phase handler for routed mouse events
 * @property {(event: TuiMouseEvent) => any} [handleMouseEvent] Optional bubble-phase handler for routed mouse events
 * @property {boolean} [wantsKeyRelease] If true, component receives key release events (Kitty protocol). Default is false - release events are filtered out.
 * @property {() => void} invalidate Invalidate any cached rendering state. Called when theme changes or when component needs to re-render from scratch.
 */

/**
 * @typedef {{ consume?: boolean; data?: string } | undefined} InputListenerResult
 */
/**
 * @typedef {(data: string) => InputListenerResult} InputListener
 */
/**
 * @typedef {{ consume?: boolean } | undefined} MouseListenerResult
 */
/**
 * @typedef {(event: MouseEvent) => MouseListenerResult} MouseListener
 */
/**
 * @typedef {"click" | "contextmenu" | "wheel"} TuiMouseEventType
 * @typedef {"capture" | "target" | "bubble"} TuiMouseEventPhase
 * @typedef {object} TuiMouseEvent
 * @property {TuiMouseEventType} type
 * @property {MouseEvent} mouseEvent
 * @property {number} row 1-based terminal row
 * @property {number} col 1-based terminal column
 * @property {SelectionPoint} point Final rendered-screen point
 * @property {SelectionPoint | null} localPoint Target component-local point when the hit region exposes local coordinates
 * @property {MouseEvent["button"]} button
 * @property {MouseEvent["modifiers"]} modifiers
 * @property {import("./render-frame.js").RenderSpan | Component} target
 * @property {import("./render-frame.js").RenderSpan | Component | null} currentTarget
 * @property {Component | null} targetComponent
 * @property {import("./render-frame.js").RenderSpan | null} span
 * @property {import("./render-frame.js").RenderRegion | null} region
 * @property {any} metadata
 * @property {TuiMouseEventPhase} phase
 * @property {boolean} defaultPrevented
 * @property {boolean} propagationStopped
 * @property {() => void} preventDefault
 * @property {() => void} stopPropagation
 */
/**
 * @typedef {{ line: number; col: number }} SelectionPoint
 */
/**
 * @typedef {{ start: SelectionPoint; end: SelectionPoint }} SelectionRange
 */

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

/**
 * @param {string} line
 * @returns {number[]}
 */
function extractKittyImageIds(line) {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = `\x1b_pinano:cursor:${randomUUID()}\x07`;

let terminalBaseStyle = "";

/**
 * Set an ANSI prefix that should be active for otherwise-unstyled TUI text.
 * App-level themes use this to avoid inheriting a user's terminal profile
 * foreground color (for example bright green in Terminal.app).
 *
 * @param {string} style
 */
export function setTerminalBaseStyle(style) {
	terminalBaseStyle = sanitizeRenderableText(style);
}

export { visibleWidth };

/**
 * Anchor position for overlays
 * @typedef {"center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "left-center" | "right-center"} OverlayAnchor
 */

/**
 * Margin configuration for overlays
 * @typedef {object} OverlayMargin
 * @property {number} [top]
 * @property {number} [right]
 * @property {number} [bottom]
 * @property {number} [left]
 */

/**
 * Value that can be absolute (number) or percentage (string like "50%")
 * @typedef {number | `${number}%`} SizeValue
 */

/**
 * Parse a SizeValue into absolute value given a reference size
 * @param {SizeValue | undefined} value
 * @param {number} referenceSize
 * @returns {number | undefined}
 */
function parseSizeValue(value, referenceSize) {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/** @returns {boolean} */
function isTermuxSession() {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 * @typedef {object} OverlayOptions
 * @property {SizeValue} [width] Width in columns, or percentage of terminal width (e.g., "50%")
 * @property {number} [minWidth] Minimum width in columns
 * @property {SizeValue} [maxHeight] Maximum height in rows, or percentage of terminal height (e.g., "50%")
 * @property {OverlayAnchor} [anchor] Anchor point for positioning (default: 'center')
 * @property {number} [offsetX] Horizontal offset from anchor position (positive = right)
 * @property {number} [offsetY] Vertical offset from anchor position (positive = down)
 * @property {SizeValue} [row] Row position: absolute number, or percentage (e.g., "25%" = 25% from top)
 * @property {SizeValue} [col] Column position: absolute number, or percentage (e.g., "50%" = centered horizontally)
 * @property {OverlayMargin | number} [margin] Margin from terminal edges. Number applies to all sides.
 * @property {(termWidth: number, termHeight: number) => boolean} [visible] Control overlay visibility based on terminal dimensions. If provided, overlay is only rendered when this returns true. Called each render cycle with current terminal dimensions.
 * @property {boolean} [nonCapturing] If true, don't capture keyboard focus when shown
 * @property {boolean} [captureMouse] If true, route mouse events outside the overlay to the overlay before underlying content can handle them
 * @property {boolean} [backdrop] If true, hide the base UI behind the overlay
 */

/**
 * Handle returned by showOverlay for controlling the overlay
 * @typedef {object} OverlayHandle
 * @property {() => void} hide Permanently remove the overlay (cannot be shown again)
 * @property {(hidden: boolean) => void} setHidden Temporarily hide or show the overlay
 * @property {() => boolean} isHidden Check if overlay is temporarily hidden
 * @property {() => void} focus Focus this overlay and bring it to the visual front
 * @property {() => void} unfocus Release focus to the previous target
 * @property {() => boolean} isFocused Check if this overlay currently has focus
 */

/**
 * @typedef {object} OverlayEntry
 * @property {Component} component
 * @property {OverlayOptions} [options]
 * @property {Component | null} preFocus
 * @property {boolean} hidden
 * @property {number} focusOrder
 */

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	/** @type {Terminal} */
	terminal;
	/** @type {string[]} */
	previousLines = [];
	/** @type {Set<number>} */
	previousKittyImageIds = new Set();
	previousWidth = 0;
	previousHeight = 0;
	/** @type {Component | null} */
	focusedComponent = null;
	/** @type {Set<InputListener>} */
	inputListeners = new Set();
	/** @type {Set<MouseListener>} */
	mouseListeners = new Set();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component.
	 * @type {(() => void) | undefined}
	 */
	onDebug;
	renderRequested = false;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	renderTimer;
	lastRenderAt = 0;
	static MIN_RENDER_INTERVAL_MS = 16;
	static DOUBLE_CLICK_INTERVAL_MS = 500;
	cursorRow = 0; // Logical cursor row (end of rendered content)
	hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	showHardwareCursor = false;
	clearOnShrink = false; // Clear empty rows when content shrinks (default: off)
	maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	previousOverlayActive = false; // Track whether previous materialized lines included overlay compositing
	fullRedrawCount = 0;
	stopped = false;
	mouseReporting = false;
	focusReporting = false;
	/** @type {ScreenMap} Final unhighlighted screen geometry from the latest render. */
	screenMap = ScreenMap.empty();
	/** @type {SelectionPoint | null} */
	selectionAnchor = null;
	/** @type {SelectionPoint | null} */
	selectionFocus = null;
	selectionActive = false;
	selectionRenderDirty = false;
	/** @type {"cell" | "word" | "line"} */
	selectionMode = "cell";
	/** @type {SelectionRange | null} */
	unitSelectionAnchorRange = null;
	/** @type {SelectionPoint | null} */
	mouseSelectionPressPoint = null;
	mouseSelectionPressPlain = false;
	mouseSelectionDragged = false;
	/** @type {{ span: import("./render-frame.js").RenderSpan, point: SelectionPoint } | null} */
	mouseClickCandidate = null;
	/** @type {{ at: number, count: number, wordRange: SelectionRange | null, lineRange: SelectionRange | null, lineText: string, viewportTop: number } | null} */
	mouseLastClick = null;
	/** @type {{ point: SelectionPoint } | null} */
	mouseContextMenuCandidate = null;
	mouseContextMenuCancelled = false;
	/** @type {HostClipboardCopy} */
	hostClipboardCopy = copyTextToHostClipboard;
	/** @type {HostClipboardCopyErrorHandler} */
	onHostClipboardCopyError = () => {};
	/** @type {TuiDiagnosticHandler} */
	onDiagnostic = () => {};
	debugRedraw = false;
	/** @type {Set<string>} */
	activeRenderViolationSignatures = new Set();
	/** @type {WeakMap<object, number>} */
	diagnosticComponentIds = new WeakMap();
	nextDiagnosticComponentId = 1;

	// Overlay stack for modal components rendered on top of base content
	focusOrderCounter = 0;
	/** @type {OverlayEntry[]} */
	overlayStack = [];

	/**
	 * @param {Terminal} terminal
	 * @param {boolean | TuiOptions} [showHardwareCursorOrOptions]
	 * @param {TuiOptions} [legacyOptions]
	 */
	constructor(terminal, showHardwareCursorOrOptions, legacyOptions = {}) {
		super();
		this.terminal = terminal;
		const options = typeof showHardwareCursorOrOptions === "object" && showHardwareCursorOrOptions !== null
			? showHardwareCursorOrOptions
			: legacyOptions;
		const showHardwareCursor = typeof showHardwareCursorOrOptions === "boolean"
			? showHardwareCursorOrOptions
			: options.showHardwareCursor;
		if (showHardwareCursor !== undefined) this.showHardwareCursor = showHardwareCursor;
		if (options.clearOnShrink !== undefined) this.clearOnShrink = options.clearOnShrink;
		this.hostClipboardCopy = options.hostClipboardCopy ?? copyTextToHostClipboard;
		this.onHostClipboardCopyError = options.onHostClipboardCopyError ?? (() => {});
		this.onDiagnostic = options.onDiagnostic ?? (() => {});
		this.debugRedraw = options.debugRedraw === true;
	}

	/** @returns {number} */
	get fullRedraws() {
		return this.fullRedrawCount;
	}

	/** @returns {boolean} */
	getShowHardwareCursor() {
		return this.showHardwareCursor;
	}

	/**
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setShowHardwareCursor(enabled) {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	/** @returns {boolean} */
	getClearOnShrink() {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true, empty rows are cleared when content shrinks. The default is false to reduce redraws on slower terminals.
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setClearOnShrink(enabled) {
		this.clearOnShrink = enabled;
	}

	/**
	 * @param {Component | null} component
	 * @returns {void}
	 */
	setFocus(component) {
		const previous = this.focusedComponent;
		// Clear focused flag on old component
		if (isFocusable(previous)) {
			previous.focused = false;
			markComponentDirty(previous);
		}

		this.focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
			markComponentDirty(component);
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 * @param {Component} component
	 * @param {OverlayOptions} [options]
	 * @returns {OverlayHandle}
	 */
	showOverlay(component, options) {
		const entry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		setComponentParent(component, this);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					setComponentParent(component, null);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				if (this.focusedComponent !== component) {
					this.setFocus(component);
				}
				entry.focusOrder = ++this.focusOrderCounter;
				this.requestRender();
			},
			unfocus: () => {
				if (this.focusedComponent !== component) return;
				const topVisible = this.getTopmostVisibleOverlay();
				this.setFocus(topVisible && topVisible !== entry ? topVisible.component : entry.preFocus);
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay() {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		setComponentParent(overlay.component, null);
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays
	 * @returns {boolean}
	 */
	hasOverlay() {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible
	 * @param {OverlayEntry} entry
	 * @returns {boolean}
	 */
	isOverlayVisible(entry) {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible capturing overlay, if any
	 * @returns {OverlayEntry | undefined}
	 */
	getTopmostVisibleOverlay() {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.overlayStack[i].options?.nonCapturing) continue;
			if (this.isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	/** Find the topmost visible overlay that captures outside mouse events.
	 * @returns {OverlayEntry | undefined}
	 */
	getTopmostMouseCaptureOverlay() {
		let top = undefined;
		for (const entry of this.overlayStack) {
			if (!entry.options?.captureMouse || !this.isOverlayVisible(entry)) continue;
			if (!top || entry.focusOrder > top.focusOrder) top = entry;
		}
		return top;
	}

	/**
	 * @param {Component | null | undefined} component
	 * @param {Component} ancestor
	 * @returns {boolean}
	 */
	componentIsWithin(component, ancestor) {
		let current = component;
		while (current) {
			if (current === ancestor) return true;
			if (current === this) return ancestor === this;
			current = componentParent(current);
		}
		return false;
	}

	invalidate() {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start() {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	/**
	 * Enable or disable SGR button-event mouse reporting. Callers should enable
	 * this only for app-owned viewports because it changes normal terminal
	 * click/selection behavior.
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setMouseReporting(enabled) {
		if (this.mouseReporting === enabled) return;
		this.mouseReporting = enabled;
		this.terminal.write(enabled
			? "\x1b[?1002h\x1b[?1006h"
			: "\x1b[?1000l\x1b[?1002l\x1b[?1006l");
	}

	/**
	 * Enable or disable terminal focus event reporting. Supporting terminals send
	 * CSI I on focus-in and CSI O on focus-out; unsupported terminals ignore this.
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setFocusReporting(enabled) {
		if (this.focusReporting === enabled) return;
		this.focusReporting = enabled;
		this.terminal.write(enabled
			? TERMINAL_FOCUS_REPORTING_ENABLE_SEQUENCE
			: TERMINAL_FOCUS_REPORTING_DISABLE_SEQUENCE);
	}

	/**
	 * Copy text through OSC 52, then try a same-text native clipboard fallback.
	 * Terminals do not report OSC 52 rejection, so the fallback is best-effort.
	 * @param {string} text
	 * @returns {void}
	 */
	copyToClipboard(text) {
		if (!text) return;
		this.terminal.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
		try {
			const result = this.hostClipboardCopy(text);
			if (result && typeof result.then === "function") {
				result.catch((err) => this.onHostClipboardCopyError(err));
			}
		} catch (err) {
			this.onHostClipboardCopyError(err);
		}
	}

	/**
	 * @param {InputListener} listener
	 * @returns {() => void}
	 */
	addInputListener(listener) {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	/**
	 * @param {InputListener} listener
	 * @returns {void}
	 */
	removeInputListener(listener) {
		this.inputListeners.delete(listener);
	}

	/**
	 * Listen for parsed mouse events that are not consumed by renderer-owned text
	 * selection. This is for app-owned behavior such as wheel scrolling.
	 * @param {MouseListener} listener
	 * @returns {() => void}
	 */
	addMouseListener(listener) {
		this.mouseListeners.add(listener);
		return () => {
			this.mouseListeners.delete(listener);
		};
	}

	/**
	 * @param {MouseListener} listener
	 * @returns {void}
	 */
	removeMouseListener(listener) {
		this.mouseListeners.delete(listener);
	}

	queryCellSize() {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop() {
		this.stopped = true;
		this.setFocusReporting(false);
		this.setMouseReporting(false);
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.write(TUI.SEGMENT_RESET);
		this.terminal.showCursor();
		this.terminal.stop();
	}

	/**
	 * @param {boolean} [force]
	 * @returns {void}
	 */
	requestRender(force = false) {
		if (force) {
			this.invalidate();
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			this.previousOverlayActive = false;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	scheduleRender() {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	/**
	 * @param {string} data
	 * @returns {void}
	 */
	handleInput(data) {
		const mouseEvent = parseMouseEvent(data);
		if (mouseEvent) {
			if (this.dispatchOverlayMouseCaptureEvent(mouseEvent)) {
				this.requestRender();
				return;
			}
			if (this.handleSelectionMouseEvent(mouseEvent)) return;
			if (this.handleContextMenuMouseEvent(mouseEvent)) {
				this.requestRender();
				return;
			}
			if (mouseEvent.type === "wheel" && this.dispatchWheelEvent(mouseEvent)) {
				this.requestRender();
				return;
			}
			for (const listener of this.mouseListeners) {
				const result = listener(mouseEvent);
				if (result?.consume) return;
			}
			return;
		}

		if (!isKeyRelease(data) && matchesKey(data, "escape") && (this.selectionActive || this.hasSelection())) {
			this.clearSelection();
			this.requestRender();
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			markComponentDirty(this.focusedComponent);
			this.requestRender();
		}
	}

	/**
	 * @param {SelectionPoint} a
	 * @param {SelectionPoint} b
	 * @returns {number}
	 */
	compareSelectionPoints(a, b) {
		if (a.line !== b.line) return a.line - b.line;
		return a.col - b.col;
	}

	/** @returns {number} */
	nowMs() {
		return performance.now();
	}

	/**
	 * @param {MouseEvent} event
	 * @returns {boolean}
	 */
	mouseEventHasModifiers(event) {
		return event.modifiers.shift || event.modifiers.alt || event.modifiers.ctrl;
	}

	/**
	 * @param {SelectionRange | null} a
	 * @param {SelectionRange | null} b
	 * @returns {boolean}
	 */
	selectionRangesEqual(a, b) {
		return !!a && !!b && this.pointsEqual(a.start, b.start) && this.pointsEqual(a.end, b.end);
	}

	/** @returns {SelectionRange | null} */
	getSelectionRange() {
		if (!this.selectionAnchor || !this.selectionFocus) return null;
		return this.compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	/** @returns {boolean} */
	hasSelection() {
		const range = this.getSelectionRange();
		return !!range && (range.start.line !== range.end.line || range.start.col !== range.end.col);
	}

	/** @returns {boolean} */
	hasSelectionState() {
		return !!(this.selectionAnchor || this.selectionFocus || this.selectionActive);
	}

	/**
	 * @param {SelectionPoint | null} point
	 * @param {ScreenMap} nextScreenMap
	 * @returns {boolean}
	 */
	selectionPointMatchesSource(point, nextScreenMap) {
		if (!point) return false;
		if (point.line < 0 || point.line >= this.screenMap.lines.length || point.line >= nextScreenMap.lines.length) return false;
		return this.screenMap.lines[point.line] === nextScreenMap.lines[point.line]
			&& point.col <= nextScreenMap.selectableLineWidth(point.line);
	}

	/**
	 * @param {SelectionPoint | null} point
	 * @param {ScreenMap} screenMap
	 * @returns {boolean}
	 */
	selectionPointInScreenMap(point, screenMap) {
		return !!point
			&& point.line >= 0
			&& point.line < screenMap.lines.length
			&& point.col >= 0
			&& point.col <= screenMap.selectableLineWidth(point.line);
	}

	/**
	 * @param {SelectionRange} range
	 * @param {ScreenMap} screenMap
	 * @returns {boolean}
	 */
	selectionRangeInScreenMap(range, screenMap) {
		return this.selectionPointInScreenMap(range.start, screenMap)
			&& this.selectionPointInScreenMap(range.end, screenMap);
	}

	/**
	 * @param {SelectionRange} range
	 * @param {ScreenMap} nextScreenMap
	 * @returns {boolean}
	 */
	selectionRangePreservesText(range, nextScreenMap) {
		if (!this.selectionRangeInScreenMap(range, this.screenMap) || !this.selectionRangeInScreenMap(range, nextScreenMap)) return false;
		return this.screenMap.copyTextForRange(range) === nextScreenMap.copyTextForRange(range);
	}

	/**
	 * @param {ScreenMap} nextScreenMap
	 * @returns {boolean}
	 */
	inactiveSelectionInvalidated(nextScreenMap) {
		if (!this.hasSelectionState() || this.selectionActive || this.screenMap.hasSameLines(nextScreenMap.lines)) return false;
		if (this.screenMap.viewportTop !== nextScreenMap.viewportTop) return true;
		const range = this.getSelectionRange();
		if (range && !this.pointsEqual(range.start, range.end)) return !this.selectionRangePreservesText(range, nextScreenMap);
		return !this.selectionPointMatchesSource(this.selectionAnchor, nextScreenMap)
			|| !this.selectionPointMatchesSource(this.selectionFocus, nextScreenMap);
	}

	/** @returns {boolean} */
	clearSelection() {
		this.mouseClickCandidate = null;
		this.mouseLastClick = null;
		this.mouseSelectionPressPoint = null;
		this.mouseSelectionPressPlain = false;
		this.mouseSelectionDragged = false;
		this.mouseContextMenuCandidate = null;
		this.mouseContextMenuCancelled = false;
		if (!this.selectionAnchor && !this.selectionFocus && !this.selectionActive) return false;
		this.selectionAnchor = null;
		this.selectionFocus = null;
		this.selectionActive = false;
		this.selectionMode = "cell";
		this.unitSelectionAnchorRange = null;
		this.selectionRenderDirty = true;
		return true;
	}

	/** @param {SelectionPoint} point */
	startSelection(point) {
		this.selectionAnchor = point;
		this.selectionFocus = point;
		this.selectionActive = true;
		this.selectionMode = "cell";
		this.unitSelectionAnchorRange = null;
		this.selectionRenderDirty = true;
		return true;
	}

	/** @param {SelectionPoint} point */
	extendSelection(point) {
		if (!this.selectionAnchor) return this.startSelection(point);
		const changed = !this.selectionActive
			|| !this.selectionFocus
			|| this.selectionFocus.line !== point.line
			|| this.selectionFocus.col !== point.col;
		this.selectionFocus = point;
		this.selectionActive = true;
		this.selectionMode = "cell";
		this.unitSelectionAnchorRange = null;
		if (changed) this.selectionRenderDirty = true;
		return changed;
	}

	/** @param {SelectionPoint} point */
	updateSelection(point) {
		if (!this.selectionActive || !this.selectionAnchor) return false;
		if (this.selectionFocus && this.selectionFocus.line === point.line && this.selectionFocus.col === point.col) return false;
		this.selectionFocus = point;
		this.selectionMode = "cell";
		this.unitSelectionAnchorRange = null;
		this.selectionRenderDirty = true;
		return true;
	}

	/**
	 * @param {SelectionRange} range
	 * @param {"word" | "line"} mode
	 */
	startUnitSelection(range, mode) {
		this.selectionAnchor = range.start;
		this.selectionFocus = range.end;
		this.selectionActive = true;
		this.selectionMode = mode;
		this.unitSelectionAnchorRange = range;
		this.mouseLastClick = null;
		this.selectionRenderDirty = true;
		return true;
	}

	/**
	 * @param {SelectionPoint} point
	 * @param {"word" | "line"} mode
	 * @returns {SelectionRange | null}
	 */
	selectionUnitRangeAtPoint(point, mode) {
		return mode === "line"
			? this.screenMap.lineRangeAtPoint(point)
			: this.screenMap.wordRangeAtPoint(point);
	}

	/** @param {SelectionPoint} point */
	updateUnitSelection(point) {
		if (!this.selectionActive || !this.unitSelectionAnchorRange || this.selectionMode === "cell") return false;
		const anchor = this.unitSelectionAnchorRange;
		const range = this.selectionUnitRangeAtPoint(point, this.selectionMode);
		let focus = point;
		if (range) {
			focus = this.compareSelectionPoints(range.start, anchor.start) < 0
				? range.start
				: range.end;
		}
		const nextAnchor = this.compareSelectionPoints(focus, anchor.start) < 0 ? anchor.end : anchor.start;
		const changed = !this.selectionAnchor
			|| !this.selectionFocus
			|| !this.pointsEqual(this.selectionAnchor, nextAnchor)
			|| !this.pointsEqual(this.selectionFocus, focus);
		this.selectionAnchor = nextAnchor;
		this.selectionFocus = focus;
		if (changed) this.selectionRenderDirty = true;
		return changed;
	}

	/** @param {SelectionPoint | null} point */
	finishSelection(point) {
		if (!this.selectionActive) return "";
		if (point) this.selectionFocus = point;
		this.selectionActive = false;
		this.selectionMode = "cell";
		this.unitSelectionAnchorRange = null;
		this.selectionRenderDirty = true;
		return this.selectedText();
	}

	/**
	 * @param {number} row 1-based terminal row
	 * @param {number} col 1-based terminal column
	 * @param {{ clampRows?: boolean }} [options]
	 * @returns {SelectionPoint | null}
	 */
	hitTestSelection(row, col, options = {}) {
		return this.screenMap.hitTest(row, col, options);
	}

	/** @returns {string} */
	selectedText() {
		const range = this.getSelectionRange();
		return this.screenMap.copyTextForRange(range);
	}

	/**
	 * @param {Component} component
	 * @returns {Component[]}
	 */
	componentEventPath(component) {
		const path = [];
		let current = component;
		while (current) {
			path.push(current);
			if (current === this) break;
			current = componentParent(current);
		}
		if (path[path.length - 1] !== this) path.push(this);
		return path.reverse();
	}

	/**
	 * @param {{ type: TuiMouseEventType; mouseEvent: MouseEvent; point: SelectionPoint; targetComponent: Component | null; span?: import("./render-frame.js").RenderSpan | null; region?: import("./render-frame.js").RenderRegion | null }} options
	 * @returns {{ event: TuiMouseEvent, setCurrentTarget: (target: import("./render-frame.js").RenderSpan | Component | null) => void, setPhase: (phase: TuiMouseEventPhase) => void }}
	 */
	createRoutedMouseEvent(options) {
		let defaultPrevented = false;
		let propagationStopped = false;
		let currentTarget = /** @type {import("./render-frame.js").RenderSpan | Component | null} */ (null);
		let phase = /** @type {TuiMouseEventPhase} */ ("target");
		const span = options.span ?? null;
		const region = options.region ?? null;
		const targetComponent = options.targetComponent;
		const target = span ?? targetComponent ?? this;
		const localPoint = localPointForRegion(options.point, region);
		return {
			event: {
				type: options.type,
				mouseEvent: options.mouseEvent,
				row: options.mouseEvent.row,
				col: options.mouseEvent.col,
				point: options.point,
				localPoint,
				button: options.mouseEvent.button,
				modifiers: options.mouseEvent.modifiers,
				target,
				get currentTarget() {
					return currentTarget;
				},
				targetComponent,
				span,
				region,
				metadata: span?.metadata,
				get phase() {
					return phase;
				},
				get defaultPrevented() {
					return defaultPrevented;
				},
				get propagationStopped() {
					return propagationStopped;
				},
				preventDefault() {
					defaultPrevented = true;
				},
				stopPropagation() {
					propagationStopped = true;
				},
			},
			setCurrentTarget(target) {
				currentTarget = target;
			},
			setPhase(nextPhase) {
				phase = nextPhase;
			},
		};
	}

	/**
	 * @param {any} result
	 * @returns {boolean}
	 */
	mouseHandlerConsumes(result) {
		return result?.consume !== false;
	}

	/**
	 * @param {{ event: TuiMouseEvent, setCurrentTarget: (target: import("./render-frame.js").RenderSpan | Component | null) => void, setPhase: (phase: TuiMouseEventPhase) => void }} routed
	 * @param {Component} component
	 * @param {TuiMouseEventPhase} phase
	 * @param {(event: TuiMouseEvent) => any} handler
	 * @returns {boolean}
	 */
	invokeComponentMouseHandler(routed, component, phase, handler) {
		routed.setPhase(phase);
		routed.setCurrentTarget(component);
		return this.mouseHandlerConsumes(handler.call(component, routed.event));
	}

	/**
	 * @param {import("./render-frame.js").RenderSpan | null} span
	 * @returns {span is import("./render-frame.js").RenderSpan}
	 */
	isInteractiveSpan(span) {
		return !!span && (typeof span.onClick === "function" || typeof span.onMouse === "function");
	}

	/**
	 * @param {{ type: TuiMouseEventType; mouseEvent: MouseEvent; point: SelectionPoint; targetComponent: Component | null; span?: import("./render-frame.js").RenderSpan | null; region?: import("./render-frame.js").RenderRegion | null }} options
	 * @returns {boolean}
	 */
	dispatchRoutedMouseEvent(options) {
		const targetComponent = options.targetComponent;
		if (!targetComponent && !options.span) return false;
		const path = targetComponent ? this.componentEventPath(targetComponent) : [this];
		const routed = this.createRoutedMouseEvent(options);
		let handled = false;
		let consumed = false;

		for (const component of path) {
			if (routed.event.propagationStopped) break;
			if (typeof component.handleMouseCapture !== "function") continue;
			handled = true;
			if (this.invokeComponentMouseHandler(routed, component, "capture", component.handleMouseCapture)) consumed = true;
		}

		const span = options.span ?? null;
		if (!routed.event.propagationStopped && (options.type === "click" || options.type === "contextmenu") && span) {
			routed.setPhase("target");
			routed.setCurrentTarget(span.component ?? span);
			let result;
			if (options.type === "click" && typeof span.onClick === "function") {
				handled = true;
				result = span.onClick(routed.event);
				if (this.mouseHandlerConsumes(result)) consumed = true;
			}
			if (options.type === "contextmenu" && typeof span.onContextMenu === "function") {
				handled = true;
				result = span.onContextMenu(routed.event);
				if (this.mouseHandlerConsumes(result)) consumed = true;
			}
			if (!routed.event.propagationStopped && typeof span.onMouse === "function") {
				handled = true;
				result = span.onMouse(routed.event);
				if (this.mouseHandlerConsumes(result)) consumed = true;
			}
		}

		for (const component of [...path].reverse()) {
			if (routed.event.propagationStopped) break;
			if (typeof component.handleMouseEvent !== "function") continue;
			handled = true;
			if (this.invokeComponentMouseHandler(routed, component, "bubble", component.handleMouseEvent)) consumed = true;
		}

		return handled && consumed;
	}

	/**
	 * @param {import("./render-frame.js").RenderSpan} span
	 * @param {MouseEvent} mouseEvent
	 * @param {SelectionPoint} point
	 * @returns {boolean}
	 */
	dispatchSpanClick(span, mouseEvent, point) {
		return this.dispatchRoutedMouseEvent({
			type: "click",
			mouseEvent,
			point,
			targetComponent: span.component ?? null,
			span,
		});
	}

	/**
	 * @param {MouseEvent} mouseEvent
	 * @param {SelectionPoint} point
	 * @returns {boolean}
	 */
	dispatchContextMenuEvent(mouseEvent, point) {
		const span = this.screenMap.spanAtPoint(point);
		const region = this.screenMap.regionAtPoint(point);
		return this.dispatchRoutedMouseEvent({
			type: "contextmenu",
			mouseEvent,
			point,
			targetComponent: span?.component ?? region?.component ?? null,
			span,
			region,
		});
	}

	/**
	 * @param {MouseEvent} mouseEvent
	 * @returns {boolean}
	 */
	dispatchWheelEvent(mouseEvent) {
		const point = this.screenMap.hitTestCell(mouseEvent.row, mouseEvent.col);
		if (!point) return false;
		const region = this.screenMap.regionAtPoint(point);
		if (!region) return false;
		return this.dispatchRoutedMouseEvent({
			type: "wheel",
			mouseEvent,
			point,
			targetComponent: region.component,
			region,
		});
	}

	/**
	 * Give opt-in overlays first refusal for mouse events outside their rendered
	 * region. Popovers use this to dismiss without letting the same click hit the
	 * UI behind them.
	 * @param {MouseEvent} mouseEvent
	 * @returns {boolean}
	 */
	dispatchOverlayMouseCaptureEvent(mouseEvent) {
		const entry = this.getTopmostMouseCaptureOverlay();
		if (!entry) return false;
		const point = this.screenMap.hitTestCell(mouseEvent.row, mouseEvent.col);
		if (!point) return false;
		const span = this.screenMap.spanAtPoint(point);
		const region = this.screenMap.regionAtPoint(point);
		const hitComponent = span?.component ?? region?.component ?? null;
		if (this.componentIsWithin(hitComponent, entry.component)) return false;

		if (mouseEvent.type === "press" && mouseEvent.button === "right") {
			this.mouseContextMenuCandidate = null;
			this.mouseContextMenuCancelled = true;
		}

		const type = mouseEvent.type === "wheel"
			? "wheel"
			: mouseEvent.button === "right" || mouseEvent.button === "none"
				? "contextmenu"
				: "click";
		return this.dispatchRoutedMouseEvent({
			type,
			mouseEvent,
			point,
			targetComponent: entry.component,
		});
	}

	/**
	 * @param {SelectionPoint | null} a
	 * @param {SelectionPoint | null} b
	 * @returns {boolean}
	 */
	pointsEqual(a, b) {
		return !!a && !!b && a.line === b.line && a.col === b.col;
	}

	/**
	 * @param {SelectionPoint} point
	 * @param {number} count
	 * @returns {void}
	 */
	recordMouseClick(point, count) {
		this.mouseLastClick = {
			at: this.nowMs(),
			count,
			wordRange: this.screenMap.wordRangeAtPoint(point),
			lineRange: this.screenMap.lineRangeAtPoint(point),
			lineText: this.screenMap.lines[point.line] ?? "",
			viewportTop: this.screenMap.viewportTop,
		};
	}

	/**
	 * @param {MouseEvent} event
	 * @param {SelectionPoint} point
	 * @param {boolean} interactive
	 * @returns {{ mode: "word" | "line" | null, range: SelectionRange | null }}
	 */
	mouseClickUnit(event, point, interactive) {
		const single = { mode: null, range: null };
		if (interactive || this.mouseEventHasModifiers(event)) return single;
		const last = this.mouseLastClick;
		if (!last) return single;
		const elapsed = this.nowMs() - last.at;
		if (elapsed < 0 || elapsed > TUI.DOUBLE_CLICK_INTERVAL_MS) return single;
		if (last.viewportTop !== this.screenMap.viewportTop) return single;
		if (last.lineText !== (this.screenMap.lines[point.line] ?? "")) return single;

		const wordRange = this.screenMap.wordRangeAtPoint(point);
		if (!this.selectionRangesEqual(last.wordRange, wordRange)) return single;
		if (last.count === 1) return { mode: "word", range: wordRange };

		const lineRange = this.screenMap.lineRangeAtPoint(point);
		if (last.count === 2 && this.selectionRangesEqual(last.lineRange, lineRange)) {
			return { mode: "line", range: lineRange };
		}
		return single;
	}

	/**
	 * @param {MouseEvent} event
	 * @returns {boolean}
	 */
	handleContextMenuMouseEvent(event) {
		if (event.type === "press" && event.button === "right") {
			const point = this.screenMap.hitTestCell(event.row, event.col);
			this.mouseContextMenuCandidate = point ? { point } : null;
			this.mouseContextMenuCancelled = false;
			return false;
		}

		if (event.type === "drag" && event.button === "right") {
			this.mouseContextMenuCandidate = null;
			this.mouseContextMenuCancelled = true;
			return false;
		}

		const releaseAfterRightPress = event.type === "release" && event.button === "none" && this.mouseContextMenuCandidate;
		const rightRelease = event.type === "release" && event.button === "right";
		if (!rightRelease && !releaseAfterRightPress) return false;

		const candidate = this.mouseContextMenuCandidate;
		const cancelled = this.mouseContextMenuCancelled;
		this.mouseContextMenuCandidate = null;
		this.mouseContextMenuCancelled = false;
		if (cancelled) return false;
		const point = this.screenMap.hitTestCell(event.row, event.col);
		if (!point) return false;
		if (candidate && !this.pointsEqual(candidate.point, point)) return false;
		return this.dispatchContextMenuEvent(event, point);
	}

	/**
	 * @param {import("./render-frame.js").RenderSpan} a
	 * @param {import("./render-frame.js").RenderSpan | null} b
	 * @returns {boolean}
	 */
	matchesClickCandidateSpan(a, b) {
		if (!b) return false;
		if (a === b) return true;
		if (a.component !== b.component) return false;
		if (a.id !== undefined || b.id !== undefined) return a.id === b.id;
		const sameRange = a.line === b.line
			&& a.startCol === b.startCol
			&& a.endCol === b.endCol;
		if (a.metadata !== undefined || b.metadata !== undefined) return a.metadata === b.metadata && sameRange;
		if (a.role !== undefined || b.role !== undefined || a.label !== undefined || b.label !== undefined) {
			return a.role === b.role && a.label === b.label && sameRange;
		}
		return sameRange;
	}

	/**
	 * @param {MouseEvent} event
	 * @returns {boolean}
	 */
	handleSelectionMouseEvent(event) {
		if (event.type === "press" && event.button === "left") {
			this.mouseContextMenuCandidate = null;
			this.mouseContextMenuCancelled = false;
			const hit = this.hitTestSelection(event.row, event.col);
			const span = event.modifiers.shift ? null : this.screenMap.spanAt(event.row, event.col);
			const interactiveSpan = this.isInteractiveSpan(span) ? span : null;
			const clickUnit = hit ? this.mouseClickUnit(event, hit, !!interactiveSpan) : { mode: null, range: null };
			this.mouseSelectionPressPoint = hit;
			this.mouseSelectionPressPlain = !this.mouseEventHasModifiers(event);
			this.mouseSelectionDragged = false;
			this.mouseClickCandidate = hit && interactiveSpan ? { point: hit, span: interactiveSpan } : null;
			if (hit) {
				if (clickUnit.mode && clickUnit.range) {
					this.mouseClickCandidate = null;
					this.startUnitSelection(clickUnit.range, clickUnit.mode);
				} else if (event.modifiers.shift) this.extendSelection(hit);
				else this.startSelection(hit);
			} else {
				this.clearSelection();
			}
			this.requestRender();
			return true;
		}

		if (event.type === "drag" && event.button === "left") {
			this.mouseClickCandidate = null;
			this.mouseSelectionDragged = true;
			const hit = this.hitTestSelection(event.row, event.col, { clampRows: true });
			if (hit) {
				const changed = this.selectionMode !== "cell"
					? this.updateUnitSelection(hit)
					: this.updateSelection(hit);
				if (changed) this.requestRender();
			}
			return true;
		}

		if (event.type === "release" && (event.button === "left" || (event.button === "none" && this.selectionActive))) {
			const hit = this.hitTestSelection(event.row, event.col, { clampRows: true });
			const finishedMode = this.selectionMode;
			const preserveUnitFocus = finishedMode !== "cell";
			const pressPoint = this.mouseSelectionPressPoint;
			const pressPlain = this.mouseSelectionPressPlain;
			const dragged = this.mouseSelectionDragged;
			this.mouseSelectionPressPoint = null;
			this.mouseSelectionPressPlain = false;
			this.mouseSelectionDragged = false;
			const selectedText = this.finishSelection(preserveUnitFocus ? null : hit);
			const clickCandidate = this.mouseClickCandidate;
			this.mouseClickCandidate = null;
			if (selectedText) {
				if (finishedMode === "word" && hit && pressPlain && !dragged && this.pointsEqual(pressPoint, hit)) this.recordMouseClick(hit, 2);
				else this.mouseLastClick = null;
				this.copyToClipboard(selectedText);
			}
			else if (clickCandidate) {
				this.mouseLastClick = null;
				const releasePoint = this.screenMap.hitTestCell(event.row, event.col);
				const releaseSpan = releasePoint ? this.screenMap.spanAtPoint(releasePoint) : null;
				if (releasePoint && this.matchesClickCandidateSpan(clickCandidate.span, releaseSpan)) {
					if (this.dispatchSpanClick(releaseSpan, event, releasePoint)) this.clearSelection();
				}
			}
			else if (hit && pressPlain && !dragged && this.pointsEqual(pressPoint, hit)) {
				this.recordMouseClick(hit, 1);
			} else {
				this.mouseLastClick = null;
			}
			this.requestRender();
			return true;
		}

		return false;
	}

	/**
	 * @param {string} data
	 * @returns {boolean}
	 */
	consumeCellSizeResponse(data) {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 * @param {OverlayOptions | undefined} options
	 * @param {number} overlayHeight
	 * @param {number} termWidth
	 * @param {number} termHeight
	 * @returns {{ width: number; row: number; col: number; maxHeight: number | undefined }}
	 */
	resolveOverlayLayout(options, overlayHeight, termWidth, termHeight) {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		/** @type {number} */
		let row;
		/** @type {number} */
		let col;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	/**
	 * @param {OverlayAnchor} anchor
	 * @param {number} height
	 * @param {number} availHeight
	 * @param {number} marginTop
	 * @returns {number}
	 */
	resolveAnchorRow(anchor, height, availHeight, marginTop) {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	/**
	 * @param {OverlayAnchor} anchor
	 * @param {number} width
	 * @param {number} availWidth
	 * @param {number} marginLeft
	 * @returns {number}
	 */
	resolveAnchorCol(anchor, width, availWidth, marginLeft) {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines, spans, source spans, and regions (sorted by focusOrder, higher = on top).
	 * @param {{ lines: string[], spans?: import("./render-frame.js").RenderSpan[], sourceSpans?: import("./render-frame.js").RenderSourceSpan[], regions?: import("./render-frame.js").RenderRegion[] }} frame
	 * @param {number} termWidth
	 * @param {number} termHeight
	 * @returns {{ lines: string[], spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }}
	 */
	compositeOverlays(frame, termWidth, termHeight) {
		const base = normalizeRenderFrame(frame);
		if (this.overlayStack.length === 0) return base;
		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		if (visibleEntries.length === 0) return base;
		const hasBackdrop = visibleEntries.some((e) => e.options?.backdrop);
		const result = hasBackdrop ? [] : [...base.lines];
		let spans = hasBackdrop ? [] : [...base.spans];
		let sourceSpans = hasBackdrop ? [] : [...base.sourceSpans];
		let regions = hasBackdrop ? [] : [...base.regions];

		// Pre-render all visible overlays and calculate positions
		/** @type {{ overlayFrame: { lines: string[], spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }; row: number; col: number; w: number; component: Component }[]} */
		const rendered = [];
		let minLinesNeeded = result.length;

		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayFrame = renderComponentFrame(component, width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayFrame.lines.length > maxHeight) {
				overlayFrame = {
					lines: overlayFrame.lines.slice(0, maxHeight),
					spans: overlayFrame.spans.filter((span) => span.line < maxHeight),
					sourceSpans: overlayFrame.sourceSpans.filter((span) => span.line < maxHeight),
					regions: overlayFrame.regions.filter((region) => region.line < maxHeight),
				};
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayFrame.lines.length, termWidth, termHeight);

			rendered.push({ overlayFrame, row, col, w: width, component });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayFrame.lines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayFrame, row, col, w, component } of rendered) {
			for (let i = 0; i < overlayFrame.lines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayFrame.lines[i]) > w ? sliceByColumn(overlayFrame.lines[i], 0, w, true) : overlayFrame.lines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					spans = removeSpanColumns(spans, idx, col, col + w);
					sourceSpans = removeSourceSpanColumns(sourceSpans, idx, col, col + w);
					regions = removeRegionColumns(regions, idx, col, col + w);
					regions.push({ line: idx, startCol: col, endCol: col + w, component, componentLine: i, componentStartCol: 0 });
					for (const span of overlayFrame.spans) {
						if (span.line !== i) continue;
						const clipped = clipSpanColumns(span, 0, w);
						if (clipped) spans.push({
							...clipped,
							line: idx,
							startCol: clipped.startCol + col,
							endCol: clipped.endCol + col,
						});
					}
					for (const span of overlayFrame.sourceSpans) {
						if (span.line !== i) continue;
						const clipped = clipSourceSpanColumns(span, 0, w);
						if (clipped) sourceSpans.push({
							...clipped,
							line: idx,
							startCol: clipped.startCol + col,
							endCol: clipped.endCol + col,
						});
					}
					for (const region of overlayFrame.regions) {
						if (region.line !== i) continue;
						const clipped = clipRegionColumns(region, 0, w);
						if (clipped) regions.push({
							...clipped,
							line: idx,
							startCol: clipped.startCol + col,
							endCol: clipped.endCol + col,
						});
					}
				}
			}
		}

		return { lines: result, spans, sourceSpans, regions };
	}

	static SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	static segmentResetWithBaseStyle() {
		return TUI.SEGMENT_RESET + terminalBaseStyle;
	}

	/**
	 * @param {string[]} lines
	 * @param {number} [start]
	 * @returns {string[]}
	 */
	applyLineResets(lines, start = 0) {
		const reset = TUI.segmentResetWithBaseStyle();
		for (let i = Math.max(0, start); i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = terminalBaseStyle + sanitizeRenderableText(normalizeTerminalOutput(line)) + reset;
			}
		}
		return lines;
	}

	/**
	 * @returns {string[]}
	 */
	applySelectionHighlight() {
		return this.screenMap.linesWithHighlight(this.getSelectionRange());
	}

	/**
	 * Convert raw component lines into terminal-ready lines while reusing the
	 * already-materialized unchanged prefix. Component render caches deliberately
	 * store raw lines; terminal resets are TUI-level concerns and must not mutate
	 * those caches.
	 * @param {string[]} rawLines
	 * @param {number} dirtyStart
	 * @returns {string[]}
	 */
	materializeTerminalLines(rawLines, dirtyStart) {
		if (dirtyStart === Infinity && this.previousLines.length === rawLines.length) {
			return this.previousLines;
		}

		const start = Math.max(0, Math.min(rawLines.length, dirtyStart === Infinity ? 0 : dirtyStart));
		const lines = start > 0 && this.previousLines.length >= start
			? this.previousLines.slice(0, start)
			: [];
		for (let i = start; i < rawLines.length; i++) {
			lines.push(rawLines[i]);
		}
		return this.applyLineResets(lines, lines.length - (rawLines.length - start));
	}

	/**
	 * @param {string[]} lines
	 * @param {number} [start]
	 * @returns {Set<number>}
	 */
	collectKittyImageIds(lines, start = 0) {
		/** @type {Set<number>} */
		const ids = new Set();
		for (let i = Math.max(0, start); i < lines.length; i++) {
			for (const id of extractKittyImageIds(lines[i])) {
				ids.add(id);
			}
		}
		return ids;
	}

	/**
	 * @param {string[]} newLines
	 * @param {number} dirtyStart
	 * @returns {Set<number>}
	 */
	collectNextKittyImageIds(newLines, dirtyStart) {
		if (dirtyStart === Infinity) return this.previousKittyImageIds;
		if (dirtyStart <= 0 || this.previousKittyImageIds.size > 0) return this.collectKittyImageIds(newLines);
		return this.collectKittyImageIds(newLines, dirtyStart);
	}

	/** @param {TuiDiagnostic} diagnostic @returns {void} */
	emitDiagnostic(diagnostic) {
		try {
			this.onDiagnostic(diagnostic);
		} catch {
			// Diagnostics are observational and must never break rendering.
		}
	}

	/** @param {Component | undefined} component @returns {number} */
	diagnosticComponentId(component) {
		if (!component || (typeof component !== "object" && typeof component !== "function")) return 0;
		let id = this.diagnosticComponentIds.get(component);
		if (id === undefined) {
			id = this.nextDiagnosticComponentId++;
			this.diagnosticComponentIds.set(component, id);
		}
		return id;
	}

	/** @param {Component | undefined} component @returns {string} */
	diagnosticComponentName(component) {
		const constructorName = component?.constructor?.name;
		if (constructorName && constructorName !== "Object") return constructorName;
		const renderName = component?.renderFrame?.name || component?.render?.name;
		return renderName || "anonymous component";
	}

	/**
	 * @param {RenderContractViolationReason} reason
	 * @param {number} lineIndex
	 * @param {number} terminalWidth
	 * @param {number} lineWidth
	 * @param {string} line
	 * @param {import("./render-frame.js").RenderRegion[]} regions
	 * @param {Set<string>} currentSignatures
	 * @returns {void}
	 */
	reportRenderContractViolation(reason, lineIndex, terminalWidth, lineWidth, line, regions, currentSignatures) {
		let region;
		for (const candidate of regions) {
			if (candidate.line === lineIndex) region = candidate;
		}
		const component = region?.component;
		const componentLine = Number.isFinite(region?.componentLine) ? Math.floor(region.componentLine) : undefined;
		const signature = `${reason}:${this.diagnosticComponentId(component)}:${componentLine ?? lineIndex}`;
		currentSignatures.add(signature);
		if (this.activeRenderViolationSignatures.has(signature)) return;
		this.emitDiagnostic({
			type: "render_contract_violation",
			reason,
			lineIndex,
			terminalWidth,
			lineWidth,
			preview: sliceByColumn(line, 0, 160, true),
			component,
			componentName: this.diagnosticComponentName(component),
			componentLine,
		});
	}

	/**
	 * Enforce the component row contract at the renderer boundary. Malformed rows are contained so they cannot inject terminal movement or trigger terminal auto-wrap; diagnostics remain advisory and bounded.
	 * @param {{ lines: string[], spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }} frame
	 * @param {number} terminalWidth
	 * @returns {{ frame: { lines: string[], spans: import("./render-frame.js").RenderSpan[], sourceSpans: import("./render-frame.js").RenderSourceSpan[], regions: import("./render-frame.js").RenderRegion[] }, cursorPos: { row: number, col: number } | null }}
	 */
	containRenderableFrame(frame, terminalWidth) {
		const width = Math.max(0, Math.floor(terminalWidth));
		const currentSignatures = new Set();
		/** @type {{ row: number, col: number } | null} */
		let cursorPos = null;
		const lines = frame.lines.map((rawLine, lineIndex) => {
			if (isImageLine(rawLine)) return rawLine;
			const hasLineBreak = rawLine.includes("\n") || rawLine.includes("\r");
			const markerIndex = rawLine.indexOf(CURSOR_MARKER);
			const withoutMarker = markerIndex === -1 ? rawLine : rawLine.replace(CURSOR_MARKER, "");
			const safeLine = withoutMarker.replace(/\r\n|\r|\n/g, "↵");
			const lineWidth = visibleWidth(safeLine);
			if (markerIndex !== -1) {
				const markerPrefix = rawLine.slice(0, markerIndex).replace(/\r\n|\r|\n/g, "↵");
				cursorPos = { row: lineIndex, col: visibleWidth(sliceByColumn(markerPrefix, 0, width, true)) };
			}
			if (hasLineBreak) {
				this.reportRenderContractViolation("line_break", lineIndex, width, lineWidth, safeLine, frame.regions, currentSignatures);
			}
			if (lineWidth > width) {
				this.reportRenderContractViolation("width_overflow", lineIndex, width, lineWidth, safeLine, frame.regions, currentSignatures);
				return sliceByColumn(safeLine, 0, width, true);
			}
			return safeLine;
		});
		this.activeRenderViolationSignatures = currentSignatures;
		const clipMetadata = (entries, clip) => entries.flatMap((entry) => {
			const clipped = clip(entry, 0, width);
			return clipped ? [clipped] : [];
		});
		return {
			frame: {
				lines,
				spans: clipMetadata(frame.spans, clipSpanColumns),
				sourceSpans: clipMetadata(frame.sourceSpans, clipSourceSpanColumns),
				regions: clipMetadata(frame.regions, clipRegionColumns),
			},
			cursorPos,
		};
	}

	/**
	 * @param {Iterable<number>} ids
	 * @returns {string}
	 */
	deleteKittyImages(ids) {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	/**
	 * @param {number} firstChanged
	 * @param {number} lastChanged
	 * @returns {number}
	 */
	expandLastChangedForKittyImages(firstChanged, lastChanged) {
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	/**
	 * @param {number} firstChanged
	 * @param {number} lastChanged
	 * @returns {string}
	 */
	deleteChangedKittyImages(firstChanged, lastChanged) {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		/** @type {Set<number>} */
		const ids = new Set();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized.
	 * @param {string} baseLine
	 * @param {string} overlayLine
	 * @param {number} startCol
	 * @param {number} overlayWidth
	 * @param {number} totalWidth
	 * @returns {string}
	 */
	compositeLineAt(baseLine, overlayLine, startCol, overlayWidth, totalWidth) {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.segmentResetWithBaseStyle();
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}


	doRender() {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		/** @param {number} targetRow @returns {number} */
		const computeLineDiff = (targetRow) => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components. Retained components can reuse cached subtrees and
		// report the first raw line whose output may have changed.
		const renderResult = this.renderIncremental(width);
		let rawNewFrame = { lines: renderResult.lines, spans: renderResult.spans, sourceSpans: renderResult.sourceSpans, regions: renderResult.regions };
		let dirtyStart = renderResult.dirtyStart;

		// Composite overlays into the rendered lines (before differential compare).
		// Overlay compositing is screen-position dependent and deliberately kept as
		// a conservative full-diff path; normal typing has no overlays. When the
		// last overlay closes, the retained base tree may be clean, but previousLines
		// still contain the composited overlay rows, so force re-materialization.
		const overlayActive = this.overlayStack.length > 0;
		if (overlayActive) {
			rawNewFrame = this.compositeOverlays(rawNewFrame, width, height);
			dirtyStart = 0;
		} else if (this.previousOverlayActive) {
			dirtyStart = 0;
		}

		// Contain invalid component output before it reaches selection geometry, diffing, or terminal output. This also extracts and removes the private cursor marker before generic text sanitization can discard it.
		const contained = this.containRenderableFrame(rawNewFrame, width);
		rawNewFrame = contained.frame;
		const rawViewportTop = Math.max(0, rawNewFrame.lines.length - height);
		const cursorPos = this.showHardwareCursor && contained.cursorPos && contained.cursorPos.row >= rawViewportTop
			? contained.cursorPos
			: null;
		const rawSelectableLines = rawNewFrame.lines;
		const screenMap = ScreenMap.fromLines(rawSelectableLines, { height, spans: rawNewFrame.spans, sourceSpans: rawNewFrame.sourceSpans, regions: rawNewFrame.regions });
		if (this.inactiveSelectionInvalidated(screenMap)) {
			this.clearSelection();
		}
		this.screenMap = screenMap;
		if (this.selectionRenderDirty) {
			dirtyStart = 0;
		}
		const rawNewLines = this.applySelectionHighlight();
		this.selectionRenderDirty = false;

		const materializeStart = this.previousLines.length === 0 || widthChanged || (heightChanged && !isTermuxSession())
			? 0
			: dirtyStart;
		let newLines = this.materializeTerminalLines(rawNewLines, materializeStart);

		// Helper to clear scrollback and viewport and render all new lines
		/** @param {boolean} clear @returns {void} */
		const fullRender = (clear) => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousOverlayActive = overlayActive;
		};

		/** @param {string} reason @returns {void} */
		const logRedraw = (reason) => {
			if (!this.debugRedraw) return;
			this.emitDiagnostic({
				type: "full_redraw",
				reason,
				previousLineCount: this.previousLines.length,
				nextLineCount: newLines.length,
				terminalWidth: width,
				terminalHeight: height,
			});
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or the constructor option.
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		const diffStart = dirtyStart === Infinity ? maxLines : Math.max(0, Math.min(dirtyStart, maxLines));
		for (let i = diffStart; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			this.previousOverlayActive = overlayActive;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				if (extraLines > 0) {
					buffer += "\x1b[1B";
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				if (extraLines > 0) {
					buffer += `\x1b[${extraLines}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectNextKittyImageIds(newLines, materializeStart);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			this.previousOverlayActive = overlayActive;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			const line = newLines[i];
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectNextKittyImageIds(newLines, materializeStart);
		this.previousWidth = width;
		this.previousHeight = height;
		this.previousOverlayActive = overlayActive;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param {{ row: number; col: number } | null} cursorPos The cursor position extracted from rendered output, or null
	 * @param {number} totalLines Total number of rendered lines
	 * @returns {void}
	 */
	positionHardwareCursor(cursorPos, totalLines) {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
