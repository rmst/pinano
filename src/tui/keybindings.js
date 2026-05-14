import { matchesKey } from "./keys.js";

/** @typedef {import("./keys.js").KeyId} KeyId */

/**
 * Global keybinding registry.
 *
 * @typedef {(
 *   | "tui.editor.cursorUp"
 *   | "tui.editor.cursorDown"
 *   | "tui.editor.cursorLeft"
 *   | "tui.editor.cursorRight"
 *   | "tui.editor.cursorWordLeft"
 *   | "tui.editor.cursorWordRight"
 *   | "tui.editor.cursorLineStart"
 *   | "tui.editor.cursorLineEnd"
 *   | "tui.editor.jumpForward"
 *   | "tui.editor.jumpBackward"
 *   | "tui.editor.pageUp"
 *   | "tui.editor.pageDown"
 *   | "tui.editor.deleteCharBackward"
 *   | "tui.editor.deleteCharForward"
 *   | "tui.editor.deleteWordBackward"
 *   | "tui.editor.deleteWordForward"
 *   | "tui.editor.deleteToLineStart"
 *   | "tui.editor.deleteToLineEnd"
 *   | "tui.editor.yank"
 *   | "tui.editor.yankPop"
 *   | "tui.editor.undo"
 *   | "tui.input.newLine"
 *   | "tui.input.submit"
 *   | "tui.input.tab"
 *   | "tui.input.copy"
 *   | "tui.select.up"
 *   | "tui.select.down"
 *   | "tui.select.pageUp"
 *   | "tui.select.pageDown"
 *   | "tui.select.confirm"
 *   | "tui.select.cancel"
 * )} Keybinding
 */

/**
 * @typedef {object} KeybindingDefinition
 * @property {KeyId | KeyId[]} defaultKeys
 * @property {string} [description]
 */

/** @typedef {Record<string, KeybindingDefinition>} KeybindingDefinitions */
/** @typedef {Record<string, KeyId | KeyId[] | undefined>} KeybindingsConfig */

/** @type {KeybindingDefinitions} */
export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+d", "alt+delete"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": { defaultKeys: "shift+enter", description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
};

/**
 * @typedef {object} KeybindingConflict
 * @property {KeyId} key
 * @property {string[]} keybindings
 */

/**
 * @param {KeyId | KeyId[] | undefined} keys
 * @returns {KeyId[]}
 */
function normalizeKeys(keys) {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	/** @type {Set<KeyId>} */
	const seen = new Set();
	/** @type {KeyId[]} */
	const result = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeybindingsManager {
	/** @type {KeybindingDefinitions} */
	definitions;
	/** @type {KeybindingsConfig} */
	userBindings;
	/** @type {Map<Keybinding, KeyId[]>} */
	keysById = new Map();
	/** @type {KeybindingConflict[]} */
	conflicts = [];

	/**
	 * @param {KeybindingDefinitions} definitions
	 * @param {KeybindingsConfig} [userBindings]
	 */
	constructor(definitions, userBindings = {}) {
		this.definitions = definitions;
		this.userBindings = userBindings;
		this.rebuild();
	}

	rebuild() {
		this.keysById.clear();
		this.conflicts = [];

		/** @type {Map<KeyId, Set<Keybinding>>} */
		const userClaims = new Map();
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			if (!(keybinding in this.definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? /** @type {Set<Keybinding>} */ (new Set());
				claimants.add(/** @type {Keybinding} */ (keybinding));
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.definitions)) {
			const userKeys = this.userBindings[id];
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.keysById.set(/** @type {Keybinding} */ (id), keys);
		}
	}

	/**
	 * @param {string} data
	 * @param {Keybinding} keybinding
	 * @returns {boolean}
	 */
	matches(data, keybinding) {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * @param {Keybinding} keybinding
	 * @returns {KeyId[]}
	 */
	getKeys(keybinding) {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	/**
	 * @param {Keybinding} keybinding
	 * @returns {KeybindingDefinition}
	 */
	getDefinition(keybinding) {
		return this.definitions[keybinding];
	}

	/** @returns {KeybindingConflict[]} */
	getConflicts() {
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	/** @param {KeybindingsConfig} userBindings */
	setUserBindings(userBindings) {
		this.userBindings = userBindings;
		this.rebuild();
	}

	/** @returns {KeybindingsConfig} */
	getUserBindings() {
		return { ...this.userBindings };
	}

	/** @returns {KeybindingsConfig} */
	getResolvedBindings() {
		/** @type {KeybindingsConfig} */
		const resolved = {};
		for (const id of Object.keys(this.definitions)) {
			const keys = this.keysById.get(/** @type {Keybinding} */ (id)) ?? [];
			resolved[id] = keys.length === 1 ? keys[0] : [...keys];
		}
		return resolved;
	}
}

/** @type {KeybindingsManager | null} */
let globalKeybindings = null;

/** @param {KeybindingsManager} keybindings */
export function setKeybindings(keybindings) {
	globalKeybindings = keybindings;
}

/** @returns {KeybindingsManager} */
export function getKeybindings() {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}
