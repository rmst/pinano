/**
 * Terminal mouse parsing for modern SGR mouse reporting.
 *
 * SGR mouse sequences are emitted as:
 *   ESC [ < button ; col ; row M
 *   ESC [ < button ; col ; row m
 *
 * Rows/columns are 1-based terminal-cell coordinates. The button field encodes
 * wheel direction, drag motion, and modifier keys.
 */

/**
 * @typedef {"left" | "middle" | "right" | "none" | "wheel-up" | "wheel-down" | "wheel-left" | "wheel-right"} MouseButton
 * @typedef {"press" | "release" | "drag" | "wheel"} MouseEventType
 *
 * @typedef {object} MouseEvent
 * @property {MouseEventType} type
 * @property {MouseButton} button
 * @property {number} col 1-based terminal column
 * @property {number} row 1-based terminal row
 * @property {{ shift: boolean, alt: boolean, ctrl: boolean }} modifiers
 * @property {number} rawButton
 */

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/
export const DEFAULT_MOUSE_WHEEL_LINES = 3
const MOUSE_WHEEL_GESTURE_MS = 110
const MOUSE_WHEEL_LINES_BY_GESTURE_TICK = [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3]

function nowMs() {
	return globalThis.performance?.now?.() ?? Date.now()
}

/** @param {number} value */
function buttonName(value) {
	switch (value & 3) {
		case 0: return "left"
		case 1: return "middle"
		case 2: return "right"
		default: return "none"
	}
}

/** @param {number} value */
function wheelName(value) {
	switch (value & 3) {
		case 0: return "wheel-up"
		case 1: return "wheel-down"
		case 2: return "wheel-left"
		default: return "wheel-right"
	}
}

/**
 * @param {{ type?: string, button?: string } | null | undefined} event
 * @returns {"up" | "down" | undefined}
 */
function verticalWheelDirection(event) {
	if (event?.type !== "wheel") return undefined
	if (event.button === "wheel-up") return "up"
	if (event.button === "wheel-down") return "down"
	return undefined
}

/**
 * @param {string} data
 * @returns {MouseEvent | null}
 */
export function parseMouseEvent(data) {
	const match = data.match(SGR_MOUSE_RE)
	if (!match) return null

	const rawButton = Number(match[1])
	const col = Number(match[2])
	const row = Number(match[3])
	if (!Number.isInteger(rawButton) || !Number.isInteger(col) || !Number.isInteger(row)) return null
	if (col <= 0 || row <= 0) return null

	const wheel = (rawButton & 64) !== 0
	const drag = (rawButton & 32) !== 0
	return {
		type: wheel ? "wheel" : match[4] === "m" ? "release" : drag ? "drag" : "press",
		button: wheel ? wheelName(rawButton) : buttonName(rawButton),
		col,
		row,
		modifiers: {
			shift: (rawButton & 4) !== 0,
			alt: (rawButton & 8) !== 0,
			ctrl: (rawButton & 16) !== 0,
		},
		rawButton,
	}
}

/**
 * Convert vertical mouse-wheel events into signed line deltas. Horizontal
 * wheel events are intentionally ignored until a component has horizontal
 * scroll semantics.
 *
 * @param {{ type?: string, button?: string } | null | undefined} event
 * @param {number} [lines]
 * @returns {number}
 */
export function wheelDeltaFromMouseEvent(event, lines = DEFAULT_MOUSE_WHEEL_LINES) {
	const direction = verticalWheelDirection(event)
	if (!direction) return 0
	const distance = Math.max(1, Math.trunc(Math.abs(lines)))
	return direction === "up" ? -distance : distance
}

export class MouseWheelDeltaTracker {
	lastDirection = undefined
	lastWheelAt = -Infinity
	tickCount = 0

	/**
	 * Terminal mouse wheel reports are discrete ticks without pixel deltas. Treat close same-direction ticks as one gesture and ramp line movement within it.
	 * @param {{ type?: string, button?: string } | null | undefined} event
	 * @param {number} [timestamp]
	 * @returns {number}
	 */
	deltaFromEvent(event, timestamp = nowMs()) {
		const direction = verticalWheelDirection(event)
		if (!direction) return 0

		const elapsed = timestamp - this.lastWheelAt
		const continuingGesture = direction === this.lastDirection && elapsed >= 0 && elapsed <= MOUSE_WHEEL_GESTURE_MS
		this.tickCount = continuingGesture ? this.tickCount + 1 : 1
		this.lastDirection = direction
		this.lastWheelAt = timestamp

		const lines = MOUSE_WHEEL_LINES_BY_GESTURE_TICK[Math.min(this.tickCount, MOUSE_WHEEL_LINES_BY_GESTURE_TICK.length) - 1]
		return direction === "up" ? -lines : lines
	}
}
