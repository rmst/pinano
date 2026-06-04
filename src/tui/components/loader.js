import { Text } from "./text.js";

/**
 * @typedef {object} LoaderIndicatorOptions
 * @property {string[]} [frames] Animation frames. Use an empty array to hide the indicator.
 * @property {number} [intervalMs] Frame interval in milliseconds for animated indicators.
 */

export const LOADER_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const LOADER_SPINNER_INTERVAL_MS = 80;

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
	/** @type {string[]} */
	frames = [...LOADER_SPINNER_FRAMES];
	/** @type {number} */
	intervalMs = LOADER_SPINNER_INTERVAL_MS;
	/** @type {number} */
	currentFrame = 0;
	/** @type {ReturnType<typeof setInterval> | null} */
	intervalId = null;
	/** @type {import("../tui.js").TUI | null} */
	ui = null;
	/** @type {boolean} */
	renderIndicatorVerbatim = false;
	/** @type {(str: string) => string} */
	spinnerColorFn;
	/** @type {(str: string) => string} */
	messageColorFn;
	/** @type {string} */
	message;

	/**
	 * @param {import("../tui.js").TUI} ui
	 * @param {(str: string) => string} spinnerColorFn
	 * @param {(str: string) => string} messageColorFn
	 * @param {string} [message]
	 * @param {LoaderIndicatorOptions} [indicator]
	 */
	constructor(ui, spinnerColorFn, messageColorFn, message = "Loading...", indicator) {
		super("", 1, 0);
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.ui = ui;
		this.setIndicator(indicator);
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		return ["", ...super.render(width)];
	}

	start() {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** @param {string} message */
	setMessage(message) {
		this.message = message;
		this.updateDisplay();
	}

	/** @param {LoaderIndicatorOptions} [indicator] */
	setIndicator(indicator) {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...LOADER_SPINNER_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : LOADER_SPINNER_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	restartAnimation() {
		this.stop();
		if (this.frames.length <= 1) {
			return;
		}
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, this.intervalMs);
	}

	updateDisplay() {
		const frame = this.frames[this.currentFrame] ?? "";
		const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
		const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
