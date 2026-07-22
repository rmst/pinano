import { fuzzyFilter } from "../fuzzy.js";
import { getKeybindings } from "../keybindings.js";
import { nextSelectionIndex } from "../list-navigation.js";
import { MouseWheelDeltaTracker } from "../mouse.js";
import { RetainedComponent, setComponentParent } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { Input } from "./input.js";

/**
 * @typedef {object} SettingItem
 * @property {string} id Unique identifier for this setting
 * @property {string} label Display label (left side)
 * @property {string} [description] Optional description shown when selected
 * @property {string} currentValue Current value to display (right side)
 * @property {string[]} [values] If provided, Enter/Space cycles through these values
 * @property {(currentValue: string, done: (selectedValue?: string) => void) => import("../tui.js").Component} [submenu] If provided, Enter opens this submenu. Receives current value and done callback.
 */

/**
 * @typedef {object} SettingsListTheme
 * @property {(text: string, selected: boolean) => string} label
 * @property {(text: string, selected: boolean) => string} value
 * @property {(text: string) => string} description
 * @property {string} cursor
 * @property {(text: string) => string} hint
 */

/**
 * @typedef {object} SettingsListOptions
 * @property {boolean} [enableSearch]
 */

/** @implements {import("../tui.js").Component} */
export class SettingsList extends RetainedComponent {
	/** @type {SettingItem[]} */
	items;
	/** @type {SettingItem[]} */
	filteredItems;
	/** @type {SettingsListTheme} */
	theme;
	/** @type {number} */
	selectedIndex = 0;
	/** @type {number} */
	maxVisible;
	/** @type {(id: string, newValue: string) => void} */
	onChange;
	/** @type {() => void} */
	onCancel;
	/** @type {Input | undefined} */
	searchInput;
	/** @type {boolean} */
	searchEnabled;
	wheelDeltas = new MouseWheelDeltaTracker();

	// Submenu state
	/** @type {import("../tui.js").Component | null} */
	submenuComponent = null;
	/** @type {number | null} */
	submenuItemIndex = null;

	/**
	 * @param {SettingItem[]} items
	 * @param {number} maxVisible
	 * @param {SettingsListTheme} theme
	 * @param {(id: string, newValue: string) => void} onChange
	 * @param {() => void} onCancel
	 * @param {SettingsListOptions} [options]
	 */
	constructor(items, maxVisible, theme, onChange, onCancel, options = {}) {
		super();
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
			setComponentParent(this.searchInput, this);
		}
	}

	/**
	 * Update an item's currentValue
	 * @param {string} id
	 * @param {string} newValue
	 */
	updateValue(id, newValue) {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
			this.markDirty();
		}
	}

	invalidate() {
		this.markDirty();
		this.submenuComponent?.invalidate?.();
	}

	displayItems() {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	/**
	 * @param {number} delta
	 * @param {{ wrap?: boolean }} [options]
	 * @returns {boolean}
	 */
	moveSelection(delta, options = {}) {
		const displayItems = this.displayItems();
		const next = nextSelectionIndex(this.selectedIndex, displayItems.length, delta, { wrap: options.wrap !== false });
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.markDirty();
		return true;
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	render(width) {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	/**
	 * @param {number} width
	 * @returns {string[]}
	 */
	renderMainList(width) {
		/** @type {string[]} */
		const lines = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.displayItems();
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	/** @param {string} data */
	handleInput(data) {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			const sanitized = data.replace(/ /g, "");
			if (!sanitized) {
				return;
			}
			this.searchInput.handleInput(sanitized);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/** @param {import("../tui.js").TuiMouseEvent} event */
	handleMouseEvent(event) {
		if (this.submenuComponent?.handleMouseEvent) {
			return this.submenuComponent.handleMouseEvent(event);
		}
		const delta = this.wheelDeltas.deltaFromEvent(event);
		if (delta === 0) return { consume: false };
		this.moveSelection(delta, { wrap: false });
		return { consume: true };
	}

	activateItem() {
		const item = this.displayItems()[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
			setComponentParent(this.submenuComponent, this);
			this.markDirty();
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.markDirty();
			this.onChange(item.id, newValue);
		}
	}

	closeSubmenu() {
		if (this.submenuComponent) setComponentParent(this.submenuComponent, null);
		this.submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
		this.markDirty();
	}

	/** @param {string} query */
	applyFilter(query) {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
		this.markDirty();
	}

	/**
	 * @param {string[]} lines
	 * @param {number} width
	 */
	addHintLine(lines, width) {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
