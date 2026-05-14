import { getKeybindings } from "../keybindings.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

/**
 * @param {string} text
 * @returns {string}
 */
const normalizeToSingleLine = (text) => text.replace(/[\r\n]+/g, " ").trim();
/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/**
 * @typedef {object} SelectItem
 * @property {string} value
 * @property {string} label
 * @property {string} [description]
 */

/**
 * @typedef {object} SelectListTheme
 * @property {(text: string) => string} selectedPrefix
 * @property {(text: string) => string} selectedText
 * @property {(text: string) => string} description
 * @property {(text: string) => string} scrollInfo
 * @property {(text: string) => string} noMatch
 */

/**
 * @typedef {object} SelectListTruncatePrimaryContext
 * @property {string} text
 * @property {number} maxWidth
 * @property {number} columnWidth
 * @property {SelectItem} item
 * @property {boolean} isSelected
 */

/**
 * @typedef {object} SelectListLayoutOptions
 * @property {number} [minPrimaryColumnWidth]
 * @property {number} [maxPrimaryColumnWidth]
 * @property {(context: SelectListTruncatePrimaryContext) => string} [truncatePrimary]
 */

/** @implements {import("../tui.js").Component} */
export class SelectList {
	/** @type {SelectItem[]} */
	items = [];
	/** @type {SelectItem[]} */
	filteredItems = [];
	/** @type {number} */
	selectedIndex = 0;
	/** @type {number} */
	maxVisible = 5;
	/** @type {SelectListTheme} */
	theme;
	/** @type {SelectListLayoutOptions} */
	layout;

	/** @type {((item: SelectItem) => void) | undefined} */
	onSelect;
	/** @type {(() => void) | undefined} */
	onCancel;
	/** @type {((item: SelectItem) => void) | undefined} */
	onSelectionChange;

	/**
	 * @param {SelectItem[]} items
	 * @param {number} maxVisible
	 * @param {SelectListTheme} theme
	 * @param {SelectListLayoutOptions} [layout]
	 */
	constructor(items, maxVisible, theme, layout = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	/** @param {string} filter */
	setFilter(filter) {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	/** @param {number} index */
	setSelectedIndex(index) {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate() {
		// No cached state to invalidate currently
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		/** @type {string[]} */
		const lines = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	/** @param {string} keyData */
	handleInput(keyData) {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * @param {SelectItem} item
	 * @param {boolean} isSelected
	 * @param {number} width
	 * @param {string | undefined} descriptionSingleLine
	 * @param {number} primaryColumnWidth
	 * @returns {string}
	 */
	renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth) {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	/** @returns {number} */
	getPrimaryColumnWidth() {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	/** @returns {{ min: number, max: number }} */
	getPrimaryColumnBounds() {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	/**
	 * @param {SelectItem} item
	 * @param {boolean} isSelected
	 * @param {number} maxWidth
	 * @param {number} columnWidth
	 * @returns {string}
	 */
	truncatePrimary(item, isSelected, maxWidth, columnWidth) {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	/**
	 * @param {SelectItem} item
	 * @returns {string}
	 */
	getDisplayValue(item) {
		return item.label || item.value;
	}

	notifySelectionChange() {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	/** @returns {SelectItem | null} */
	getSelectedItem() {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
