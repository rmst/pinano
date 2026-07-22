import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
const TERMINAL_EMERGENCY_RESTORE_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const TERMINAL_SIGNAL_EXIT_CODES = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
};

export const TERMINAL_EMERGENCY_RESTORE_SEQUENCE = [
	"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l",
	"\x1b[?2004l",
	"\x1b[<u\x1b[>4;0m",
	TERMINAL_PROGRESS_CLEAR_SEQUENCE,
	"\x1b[0m\x1b]8;;\x07\x1b[?25h",
].join("");

function defaultEmergencyWriteSync(text) {
	const fd = process.stdout?.fd;
	if (typeof fd === "number" && typeof fs.writeSync === "function") fs.writeSync(fd, text);
	else process.stdout.write(text);
}

function defaultScheduleExit(fn) {
	const timer = setTimeout(fn, 0);
	timer.unref?.();
}

/**
 * Install a best-effort process-wide terminal restore lease for the interval
 * where Pinano owns stdin/stdout. It restores only terminal modes Pinano may
 * enable.
 * @param {{ processLike?: NodeJS.Process, writeSync?: (text: string) => void, restoreInput?: () => void, scheduleExit?: (fn: () => void) => void }} [options]
 * @returns {{ restore: () => void, dispose: () => void }}
 */
export function installTerminalEmergencyRestore(options = {}) {
	const processLike = options.processLike ?? process;
	const writeSync = options.writeSync ?? defaultEmergencyWriteSync;
	const restoreInput = options.restoreInput ?? (() => {});
	const scheduleExit = options.scheduleExit ?? defaultScheduleExit;
	const registrations = [];
	let disposed = false;
	let restored = false;

	const restore = () => {
		if (restored) return;
		restored = true;
		try {
			writeSync(TERMINAL_EMERGENCY_RESTORE_SEQUENCE);
		} catch {}
		try {
			restoreInput();
		} catch {}
	};
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const [event, listener] of registrations.splice(0)) {
			try {
				processLike.removeListener(event, listener);
			} catch {}
		}
	};
	const on = (event, listener) => {
		try {
			processLike.on(event, listener);
			registrations.push([event, listener]);
		} catch {}
	};

	on("exit", restore);
	on("uncaughtExceptionMonitor", restore);
	for (const signal of TERMINAL_EMERGENCY_RESTORE_SIGNALS) {
		on(signal, () => {
			restore();
			dispose();
			const code = TERMINAL_SIGNAL_EXIT_CODES[signal] ?? 1;
			processLike.exitCode = code;
			scheduleExit(() => {
				if (typeof processLike.exit === "function") processLike.exit(code);
			});
		});
	}

	return { restore, dispose };
}

/**
 * Minimal terminal interface for TUI
 *
 * @typedef {object} Terminal
 * @property {(onInput: (data: string) => void, onResize: () => void) => void} start Start the terminal with input and resize handlers
 * @property {() => void} stop Stop the terminal and restore state
 * @property {(maxMs?: number, idleMs?: number) => Promise<void>} drainInput Drain stdin before exiting to prevent Kitty key release events from leaking to the parent shell over slow SSH connections.
 * @property {(data: string) => void} write Write output to terminal
 * @property {number} columns
 * @property {number} rows
 * @property {boolean} kittyProtocolActive Whether Kitty keyboard protocol is active
 * @property {(lines: number) => void} moveBy Move cursor up (negative) or down (positive) by N lines
 * @property {() => void} hideCursor Hide the cursor
 * @property {() => void} showCursor Show the cursor
 * @property {() => void} clearLine Clear current line
 * @property {() => void} clearFromCursor Clear from cursor to end of screen
 * @property {() => void} clearScreen Clear entire screen and move cursor to (0,0)
 * @property {(title: string) => void} setTitle Set terminal window title
 * @property {(active: boolean) => void} setProgress Progress indicator (OSC 9;4)
 */

/**
 * Real terminal using process.stdin/stdout
 *
 * @implements {Terminal}
 */
export class ProcessTerminal {
	/** @type {boolean} */
	wasRaw = false;
	/** @type {((data: string) => void) | undefined} */
	inputHandler;
	/** @type {(() => void) | undefined} */
	resizeHandler;
	/** @type {boolean} */
	_kittyProtocolActive = false;
	/** @type {boolean} */
	_modifyOtherKeysActive = false;
	/** @type {StdinBuffer | undefined} */
	stdinBuffer;
	/** @type {((data: string) => void) | undefined} */
	stdinDataHandler;
	/** @type {ReturnType<typeof setInterval> | undefined} */
	progressInterval;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	keyboardProtocolFallbackTimer;
	/** @type {{ restore: () => void, dispose: () => void } | undefined} */
	emergencyRestore;
	/** @type {string} */
	writeLogPath = "";

	/** @param {{ writeLogPath?: string }} [options] */
	constructor(options = {}) {
		const requestedPath = options.writeLogPath ?? "";
		if (!requestedPath) return;
		try {
			if (fs.statSync(requestedPath).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				this.writeLogPath = path.join(requestedPath, `tui-${ts}-${process.pid}.log`);
				return;
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		this.writeLogPath = requestedPath;
	}

	/** @returns {boolean} */
	get kittyProtocolActive() {
		return this._kittyProtocolActive;
	}

	/**
	 * @param {(data: string) => void} onInput
	 * @param {() => void} onResize
	 */
	start(onInput, onResize) {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		this.emergencyRestore?.dispose();
		this.emergencyRestore = installTerminalEmergencyRestore({
			restoreInput: () => this.restoreProcessState(),
			writeSync: (text) => this.writeEmergency(text),
		});
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	setupStdinBuffer() {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			// Check for Kitty protocol response (only if not already enabled)
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys (shifted key, base layout key)
					// Base layout key enables shortcuts to work with non-Latin keyboard layouts
					process.stdout.write("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		/** @param {string} data */
		this.stdinDataHandler = (data) => {
			this.stdinBuffer.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * If no Kitty response arrives shortly after startup, fall back to enabling
	 * xterm modifyOtherKeys mode 2. This is needed for tmux, which can forward
	 * modified enter keys as CSI-u when extended-keys is enabled, but may not
	 * answer the Kitty protocol query.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	queryAndEnableKittyProtocol() {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler);
		process.stdout.write("\x1b[?u");
		this.clearKeyboardProtocolFallbackTimer();
		this.keyboardProtocolFallbackTimer = setTimeout(() => {
			this.keyboardProtocolFallbackTimer = undefined;
			if (!this.inputHandler) return;
			if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
				process.stdout.write("\x1b[>4;2m");
				this._modifyOtherKeysActive = true;
			}
		}, 150);
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	enableWindowsVTInput() {
		if (process.platform !== "win32") return;
		try {
			// Dynamic require to avoid bundling koffi's 74MB of cross-platform
			// native binaries into every compiled binary. Koffi is only needed
			// on Windows for VT input support.
			const koffi = cjsRequire("koffi");
			const k32 = koffi.load("kernel32.dll");
			const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
			const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
			const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");

			const STD_INPUT_HANDLE = -10;
			const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
			const handle = GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			GetConsoleMode(handle, mode);
			SetConsoleMode(handle, mode[0] | ENABLE_VIRTUAL_TERMINAL_INPUT);
		} catch {
			// koffi not available — Shift+Tab won't be distinguishable from Tab
		}
	}

	/**
	 * @param {number} [maxMs]
	 * @param {number} [idleMs]
	 * @returns {Promise<void>}
	 */
	async drainInput(maxMs = 1000, idleMs = 50) {
		this.clearKeyboardProtocolFallbackTimer();
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop() {
		this.clearKeyboardProtocolFallbackTimer();
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this._kittyProtocolActive) {
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		this.restoreProcessState();
		this.emergencyRestore?.dispose();
		this.emergencyRestore = undefined;
	}

	restoreProcessState() {
		this.clearKeyboardProtocolFallbackTimer();
		this.clearProgressInterval();

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
		if (this._kittyProtocolActive) {
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this._modifyOtherKeysActive = false;
	}

	/** @param {string} data */
	write(data) {
		process.stdout.write(data);
		this.recordWrite(data);
	}

	/** @param {string} data */
	writeEmergency(data) {
		try {
			const fd = process.stdout?.fd;
			if (typeof fd === "number" && typeof fs.writeSync === "function") fs.writeSync(fd, data);
			else process.stdout.write(data);
		} finally {
			this.recordWrite(data);
		}
	}

	/** @param {string} data */
	recordWrite(data) {
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	/** @returns {number} */
	get columns() {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	/** @returns {number} */
	get rows() {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	/** @param {number} lines */
	moveBy(lines) {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor() {
		process.stdout.write("\x1b[?25l");
	}

	showCursor() {
		process.stdout.write("\x1b[?25h");
	}

	clearLine() {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor() {
		process.stdout.write("\x1b[J");
	}

	clearScreen() {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	/** @param {string} title */
	setTitle(title) {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	/** @param {boolean} active */
	setProgress(active) {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	/** @returns {boolean} */
	clearProgressInterval() {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}

	/** @returns {boolean} */
	clearKeyboardProtocolFallbackTimer() {
		if (!this.keyboardProtocolFallbackTimer) return false;
		clearTimeout(this.keyboardProtocolFallbackTimer);
		this.keyboardProtocolFallbackTimer = undefined;
		return true;
	}
}
