import { getKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	/** @type {AbortController} */
	abortController = new AbortController();

	/** @type {(() => void) | undefined} Called when user presses Escape */
	onAbort;

	/**
	 * AbortSignal that is aborted when user presses Escape
	 * @returns {AbortSignal}
	 */
	get signal() {
		return this.abortController.signal;
	}

	/**
	 * Whether the loader was aborted
	 * @returns {boolean}
	 */
	get aborted() {
		return this.abortController.signal.aborted;
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose() {
		this.stop();
	}
}
