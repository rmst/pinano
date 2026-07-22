import { clickableRowSpan } from "../clickable-rows.js"
import { getKeybindings } from "../keybindings.js"
import { matchesKey } from "../keys.js"
import { nextSelectionIndex } from "../list-navigation.js"
import { MouseWheelDeltaTracker } from "../mouse.js"
import { RetainedComponent } from "../tui.js"
import { truncateToWidth, visibleWidth } from "../utils.js"

/**
 * @typedef {object} ContextMenuAction
 * @property {string} id
 * @property {string} label
 * @property {boolean} [disabled]
 * @property {boolean} [danger]
 * @property {() => void | Promise<void>} [onSelect]
 */

/**
 * @typedef {object} ContextMenuSeparator
 * @property {"separator"} type
 * @property {string} [id]
 */

/** @typedef {ContextMenuAction | ContextMenuSeparator} ContextMenuItem */

/**
 * @typedef {object} ContextMenuItemStyle
 * @property {boolean} selected
 * @property {boolean} disabled
 * @property {boolean} danger
 */

/**
 * @typedef {object} ContextMenuTheme
 * @property {(text: string) => string} [border]
 * @property {(text: string, style: ContextMenuItemStyle, item: ContextMenuAction) => string} [item]
 */

/** @param {string} text @param {number} width */
function fit(text, width) {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)))
}

/** @param {ContextMenuItem} item @returns {item is ContextMenuAction} */
function isAction(item) {
	return item?.type !== "separator"
}

/** @param {ContextMenuTheme | undefined} theme @param {string} text */
function styleBorder(theme, text) {
	return theme?.border ? theme.border(text) : text
}

/**
 * @param {ContextMenuTheme | undefined} theme
 * @param {string} text
 * @param {ContextMenuItemStyle} style
 * @param {ContextMenuAction} item
 */
function styleItem(theme, text, style, item) {
	return theme?.item ? theme.item(text, style, item) : text
}

/**
 * @param {ContextMenuItem[]} items
 * @param {(item: ContextMenuAction) => boolean} isSelectable
 */
function firstSelectableIndex(items, isSelectable) {
	return Math.max(0, items.findIndex((item) => isAction(item) && isSelectable(item)))
}

/**
 * @param {ContextMenuItem[]} items
 * @param {{ minWidth?: number, maxWidth?: number }} [options]
 */
export function contextMenuWidth(items, options = {}) {
	const minWidth = options.minWidth ?? 18
	const maxWidth = options.maxWidth ?? 36
	const labelWidth = Math.max(0, ...items.filter(isAction).map((item) => visibleWidth(item.label)))
	return Math.max(minWidth, Math.min(maxWidth, labelWidth + 4))
}

/** @implements {import("../tui.js").Component} */
export class ContextMenu extends RetainedComponent {
	/** @type {ContextMenuItem[]} */
	items
	/** @type {ContextMenuTheme | undefined} */
	theme
	/** @type {number} */
	selectedIndex = 0
	focused = false
	wheelDeltas = new MouseWheelDeltaTracker()
	/** @type {(() => void) | undefined} */
	onClose

	/**
	 * @param {ContextMenuItem[]} items
	 * @param {{ theme?: ContextMenuTheme }} [options]
	 */
	constructor(items, options = {}) {
		super()
		this.items = items
		this.theme = options.theme
		this.selectedIndex = firstSelectableIndex(items, (item) => this.isSelectable(item))
	}

	/** @param {ContextMenuAction} item */
	isSelectable(item) {
		return !item.disabled && typeof item.onSelect === "function"
	}

	/** @param {number} index */
	isSelectableIndex(index) {
		const item = this.items[index]
		return isAction(item) && this.isSelectable(item)
	}

	/** @param {number} delta */
	moveSelection(delta) {
		const next = nextSelectionIndex(this.selectedIndex, this.items.length, delta, {
			wrap: true,
			isSelectable: (index) => this.isSelectableIndex(index),
		})
		if (next === this.selectedIndex) return false
		this.selectedIndex = next
		this.markDirty()
		return true
	}

	/** @param {number} index */
	activateIndex(index) {
		const item = this.items[index]
		if (!isAction(item) || !this.isSelectable(item)) return false
		this.selectedIndex = index
		this.markDirty()
		this.onClose?.()
		void item.onSelect?.()
		return true
	}

	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings()
		if (kb.matches(data, "tui.select.up")) this.moveSelection(-1)
		else if (kb.matches(data, "tui.select.down")) this.moveSelection(1)
		else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space")) this.activateIndex(this.selectedIndex)
		else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) this.onClose?.()
	}

	/** @param {import("../tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		if (!event.region) {
			if (event.mouseEvent.type === "press" || event.mouseEvent.type === "wheel") this.onClose?.()
			return { consume: true }
		}
		const delta = this.wheelDeltas.deltaFromEvent(event)
		if (delta !== 0) this.moveSelection(delta)
		return { consume: true }
	}

	/**
	 * @param {number} width
	 * @returns {{ lines: string[], spans: import("../render-frame.js").RenderSpan[] }}
	 */
	renderFrame(width) {
		const menuWidth = Math.max(8, width)
		const border = styleBorder(this.theme, "─".repeat(menuWidth))
		const lines = [fit(border, menuWidth)]
		/** @type {import("../render-frame.js").RenderSpan[]} */
		const spans = []

		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]
			if (!isAction(item)) {
				lines.push(fit(styleBorder(this.theme, "─".repeat(menuWidth)), menuWidth))
				continue
			}
			const selected = index === this.selectedIndex && this.isSelectable(item)
			const disabled = item.disabled === true || typeof item.onSelect !== "function"
			const text = fit(`  ${truncateToWidth(item.label, Math.max(1, menuWidth - 4), "")}`, menuWidth)
			const rendered = styleItem(this.theme, text, { selected, disabled, danger: item.danger === true }, item)
			const line = lines.length
			lines.push(rendered)
			if (!disabled) {
				const span = clickableRowSpan({
					line,
					text: rendered,
					width: menuWidth,
					component: this,
					id: `context-menu.${item.id}`,
					role: "menuitem",
					label: item.label,
					metadata: { item, index },
					onClick: () => this.activateIndex(index),
				})
				if (span) spans.push(span)
			}
		}

		lines.push(fit(border, menuWidth))
		return { lines, spans }
	}

	/** @param {number} width */
	render(width) {
		return this.renderFrame(width).lines
	}
}

/**
 * @param {import("../tui.js").TUI} tui
 * @param {ContextMenuItem[]} items
 * @param {{ terminalRow: number, terminalCol: number, theme?: ContextMenuTheme, width?: number, minWidth?: number, maxWidth?: number, onClose?: () => void }} options
 */
export function showContextMenu(tui, items, options) {
	const menu = new ContextMenu(items, { theme: options.theme })
	/** @type {import("../tui.js").OverlayHandle | undefined} */
	let handle
	menu.onClose = () => {
		handle?.hide()
		options.onClose?.()
	}
	handle = tui.showOverlay(menu, {
		row: Math.max(0, Math.floor(options.terminalRow) - 1),
		col: Math.max(0, Math.floor(options.terminalCol) - 1),
		width: options.width ?? contextMenuWidth(items, { minWidth: options.minWidth, maxWidth: options.maxWidth }),
		maxHeight: "80%",
		anchor: "top-left",
		captureMouse: true,
	})
	return { menu, handle }
}
