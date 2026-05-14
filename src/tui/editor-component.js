/** @typedef {import("./autocomplete.js").AutocompleteProvider} AutocompleteProvider */
/** @typedef {import("./tui.js").Component} Component */

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 *
 * @typedef {Component & {
 *   getText(): string,
 *   setText(text: string): void,
 *   handleInput(data: string): void,
 *   onSubmit?: (text: string) => void,
 *   onChange?: (text: string) => void,
 *   addToHistory?: (text: string) => void,
 *   insertTextAtCursor?: (text: string) => void,
 *   getExpandedText?: () => string,
 *   setAutocompleteProvider?: (provider: AutocompleteProvider) => void,
 *   borderColor?: (str: string) => string,
 *   setPaddingX?: (padding: number) => void,
 *   setAutocompleteMaxVisible?: (maxVisible: number) => void,
 * }} EditorComponent
 */

export {};
